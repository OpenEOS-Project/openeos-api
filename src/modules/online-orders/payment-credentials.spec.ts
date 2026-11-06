import { randomUUID } from 'crypto';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';

import {
  ENCRYPTED_CREDENTIAL_PREFIX,
  getIntegrationKeyring,
  isEncryptedCredential,
  resetIntegrationKeyring,
} from '../../common/services/integration-credentials.crypto';
import { redactResponse } from '../../common/utils/response-redaction.util';
import { Event } from '../../database/entities/event.entity';
import { OnlineOrderSession } from '../../database/entities/online-order-session.entity';
import { Order } from '../../database/entities/order.entity';
import {
  Organization,
  OrganizationSettings,
} from '../../database/entities/organization.entity';
import { Payment } from '../../database/entities/payment.entity';
import { UserOrganization } from '../../database/entities/user-organization.entity';
import { organizationSettingsTransformer } from '../../database/transformers/organization-settings.transformer';
import { GatewayService } from '../gateway/gateway.service';
import { IntegrationCredentialsBackfillService } from '../organizations/integration-credentials-backfill.service';
import { PayPalService } from '../payments/providers/paypal.service';
import { OrderPrintService } from '../print-jobs/order-print.service';
import { SumUpApiService } from '../sumup/sumup-api.service';
import { SumUpService } from '../sumup/sumup.service';
import { CreateOnlinePaymentDto, OnlinePaymentMethod } from './dto';
import { OnlineOrdersService } from './online-orders.service';

/**
 * SumUp und PayPal bekommen die Zugangsdaten im Klartext, obwohl sie
 * verschluesselt in der Datenbank liegen. HTTP ist gemockt (global fetch);
 * geprueft wird, was beim Anbieter ankaeme.
 *
 * Der obere Block laeuft immer und bildet das Laden durch TypeORM mit dem
 * Spalten-Transformer nach. Der untere laeuft nur mit einer
 * Wegwerf-Datenbank und geht den echten Weg ueber das Repository:
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://openeos@127.0.0.1:5432/openeos_credentials_scratch pnpm test
 *
 * Der Name der Datenbank muss auf `_test` oder `_scratch` enden.
 */

const KEY = 'payment-credentials-test-key-0123456789abcdef';
const SUMUP_KEY = 'sup_sk_REALSECRET1234';
const PAYPAL_ID = 'pp_client_id';
const PAYPAL_SECRET = 'PAYPAL_SECRET_XYZ';

function plainSettings(): OrganizationSettings {
  return {
    currency: 'EUR',
    timezone: 'Europe/Berlin',
    locale: 'de',
    sumup: { apiKey: SUMUP_KEY, merchantCode: 'MC123' },
    paypal: { clientId: PAYPAL_ID, clientSecret: PAYPAL_SECRET },
    integrations: { sumup: { enabled: true } },
  } as OrganizationSettings;
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function urlOf(input: unknown): string {
  return typeof input === 'string' ? input : (input as URL).toString();
}

function mockFetch() {
  return jest.spyOn(global, 'fetch').mockImplementation((input) => {
    const url = urlOf(input);
    if (url.endsWith('/v1/oauth2/token')) {
      return Promise.resolve(jsonResponse({ access_token: 'pp-access' }));
    }
    if (url.endsWith('/v2/checkout/orders')) {
      return Promise.resolve(
        jsonResponse({
          id: 'PP-ORDER-1',
          status: 'CREATED',
          links: [{ rel: 'approve', href: 'https://paypal/approve' }],
        }),
      );
    }
    if (url === 'https://api.sumup.com/v0.1/checkouts') {
      return Promise.resolve(
        jsonResponse({ id: 'chk-1', hosted_checkout_url: 'https://pay/chk-1' }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });
}

function headerOf(call: unknown[], name: string): string | undefined {
  const init = call[1] as { headers?: Record<string, string> } | undefined;
  return init?.headers?.[name];
}

const config = {
  get: jest.fn((key: string, fallback?: unknown) =>
    key === 'FRONTEND_URL' ? 'https://order.test' : fallback,
  ),
} as unknown as ConfigService;

function sumUpService(orgRepo: Repository<Organization>): SumUpService {
  return new SumUpService(
    orgRepo,
    {} as Repository<UserOrganization>,
    new SumUpApiService(),
    config,
    {} as Repository<Event>,
  );
}

function onlineOrdersService(
  orgRepo: Repository<Organization>,
  organizationId: string,
): OnlineOrdersService {
  const session = {
    id: 'session-1',
    organizationId,
    organization: { id: organizationId },
    isExpired: () => false,
  } as unknown as OnlineOrderSession;
  const order = { id: 'order-1', total: 12.5, dailyNumber: 7 } as Order;
  // Nur die Methoden, die initiatePayment() braucht.
  const repo = (impl: object) => impl as never;
  return new OnlineOrdersService(
    repo({ findOne: jest.fn(() => Promise.resolve(session)) }),
    repo({}),
    repo({}),
    repo({}),
    repo({ findOne: jest.fn(() => Promise.resolve(order)) }),
    repo({}),
    orgRepo,
    repo({
      create: jest.fn((p: Partial<Payment>) => ({ id: 'payment-1', ...p })),
      save: jest.fn((p: Payment) => Promise.resolve(p)),
    }),
    new PayPalService(config),
    sumUpService(orgRepo),
    config,
    {} as OrderPrintService,
    {} as GatewayService,
  );
}

async function expectDecryptedAtProviders(
  orgRepo: Repository<Organization>,
  organizationId: string,
): Promise<void> {
  const fetchMock = mockFetch();
  try {
    // SumUp: Online-Checkout (Bestellseite) ueber SumUpService.
    await expect(
      sumUpService(orgRepo).createOnlineCheckout(
        organizationId,
        12.5,
        'EUR',
        'Bestellung',
        'https://order.test/status',
      ),
    ).resolves.toEqual({
      checkoutUrl: 'https://pay/chk-1',
      checkoutId: 'chk-1',
    });
    const sumupCall = fetchMock.mock.calls.find(
      ([url]) => urlOf(url) === 'https://api.sumup.com/v0.1/checkouts',
    );
    expect(headerOf(sumupCall!, 'Authorization')).toBe(`Bearer ${SUMUP_KEY}`);

    // PayPal: Zahlung der Online-Bestellung.
    const dto: CreateOnlinePaymentDto = {
      paymentMethod: OnlinePaymentMethod.PAYPAL,
    } as CreateOnlinePaymentDto;
    const result = await onlineOrdersService(
      orgRepo,
      organizationId,
    ).initiatePayment('token', dto);
    expect(result.data).toMatchObject({
      provider: 'paypal',
      paypalOrderId: 'PP-ORDER-1',
      approveUrl: 'https://paypal/approve',
    });
    const tokenCall = fetchMock.mock.calls.find(([url]) =>
      urlOf(url).endsWith('/v1/oauth2/token'),
    );
    expect(headerOf(tokenCall!, 'Authorization')).toBe(
      `Basic ${Buffer.from(`${PAYPAL_ID}:${PAYPAL_SECRET}`).toString('base64')}`,
    );

    for (const call of fetchMock.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(ENCRYPTED_CREDENTIAL_PREFIX);
    }
  } finally {
    fetchMock.mockRestore();
  }
}

const env = { ...process.env };

beforeAll(() => {
  process.env.INTEGRATION_ENCRYPTION_KEY = KEY;
  resetIntegrationKeyring();
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterAll(() => {
  process.env = env;
  resetIntegrationKeyring();
});

describe('payment providers receive decrypted credentials', () => {
  function repositoryReturning(stored: unknown): Repository<Organization> {
    return {
      // So laedt TypeORM: Rohwert aus der Spalte durch `from`.
      findOne: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve({
          id: where.id,
          settings: organizationSettingsTransformer.from(
            structuredClone(stored),
          ) as OrganizationSettings,
        }),
      ),
    } as unknown as Repository<Organization>;
  }

  it('with encrypted credentials in the database', async () => {
    const stored = organizationSettingsTransformer.to(plainSettings()) as {
      sumup: { apiKey: string };
      paypal: { clientSecret: string };
    };
    expect(isEncryptedCredential(stored.sumup.apiKey)).toBe(true);
    expect(isEncryptedCredential(stored.paypal.clientSecret)).toBe(true);

    await expectDecryptedAtProviders(repositoryReturning(stored), 'org-1');
  });

  it('with legacy plaintext credentials', async () => {
    await expectDecryptedAtProviders(
      repositoryReturning(plainSettings()),
      'org-1',
    );
  });
});

const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

describeWithDb('payment credentials against Postgres', () => {
  let ds: DataSource;
  let orgRepo: Repository<Organization>;
  const orgIds: string[] = [];

  beforeAll(async () => {
    const name = new URL(TEST_DB!).pathname.replace(/^\//, '');
    if (!/_(test|scratch)$/.test(name)) {
      throw new Error(
        `Database "${name}" does not end in _test/_scratch — aborting.`,
      );
    }
    ds = new DataSource({
      type: 'postgres',
      url: TEST_DB,
      entities: [path.join(__dirname, '../../database/entities/*.entity.ts')],
      migrations: [path.join(__dirname, '../../database/migrations/*.ts')],
      migrationsRun: true,
      logging: false,
    });
    await ds.initialize();
    orgRepo = ds.getRepository(Organization);
  }, 120_000);

  afterAll(async () => {
    if (ds?.isInitialized) {
      if (orgIds.length) {
        await ds.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [
          orgIds,
        ]);
      }
      await ds.destroy();
    }
  });

  async function rawSettings(id: string): Promise<OrganizationSettings> {
    const [row] = await ds.query<{ settings: OrganizationSettings }[]>(
      `SELECT settings FROM organizations WHERE id = $1`,
      [id],
    );
    return row.settings;
  }

  it('stores credentials encrypted and loads them decrypted', async () => {
    const id = randomUUID();
    orgIds.push(id);
    await orgRepo.save(
      orgRepo.create({
        id,
        name: 'Testverein',
        slug: `testverein-${id}`,
        supportPin: '123456',
        settings: plainSettings(),
      }),
    );

    const raw = await rawSettings(id);
    expect(isEncryptedCredential(raw.sumup!.apiKey)).toBe(true);
    expect(isEncryptedCredential(raw.paypal!.clientSecret)).toBe(true);
    expect(raw.sumup!.merchantCode).toBe('MC123');
    expect(JSON.stringify(raw)).not.toMatch(/REALSECRET|SECRET_XYZ/);

    const loaded = await orgRepo.findOneByOrFail({ id });
    expect(loaded.settings.sumup?.apiKey).toBe(SUMUP_KEY);
    expect(loaded.settings.paypal?.clientSecret).toBe(PAYPAL_SECRET);
    expect(redactResponse(loaded).settings.sumup?.apiKey).toBe('****1234');

    // Speichern ohne Aenderung an den Einstellungen schreibt sie nicht neu.
    loaded.name = 'Testverein e. V.';
    await orgRepo.save(loaded);
    expect(await rawSettings(id)).toEqual(raw);

    // Geaenderte Einstellungen: wieder verschluesselt geschrieben.
    loaded.settings = {
      ...loaded.settings,
      sumup: { ...loaded.settings.sumup!, merchantCode: 'MC456' },
    };
    await orgRepo.save(loaded);
    const changed = await rawSettings(id);
    expect(changed.sumup!.merchantCode).toBe('MC456');
    expect(isEncryptedCredential(changed.sumup!.apiKey)).toBe(true);
    expect(isEncryptedCredential(changed.paypal!.clientSecret)).toBe(true);
    expect(loaded.settings.sumup?.apiKey).toBe(SUMUP_KEY);

    await expectDecryptedAtProviders(orgRepo, id);
  });

  it('reads legacy plaintext and the backfill encrypts it once', async () => {
    const id = randomUUID();
    orgIds.push(id);
    await ds.query(
      `INSERT INTO organizations (id, name, slug, support_pin, settings)
       VALUES ($1, 'Altverein', $2, '123456', $3::jsonb)`,
      [id, `altverein-${id}`, JSON.stringify(plainSettings())],
    );

    expect((await orgRepo.findOneByOrFail({ id })).settings.sumup?.apiKey).toBe(
      SUMUP_KEY,
    );
    await expectDecryptedAtProviders(orgRepo, id);

    const backfill = new IntegrationCredentialsBackfillService(ds);
    const first = await backfill.run(getIntegrationKeyring());
    expect(first.encrypted).toBeGreaterThanOrEqual(2);
    const afterFirst = await rawSettings(id);
    expect(isEncryptedCredential(afterFirst.sumup!.apiKey)).toBe(true);
    expect(isEncryptedCredential(afterFirst.paypal!.clientSecret)).toBe(true);

    const second = await backfill.run(getIntegrationKeyring());
    expect(second).toEqual({ encrypted: 0, reencrypted: 0, undecryptable: 0 });
    expect(await rawSettings(id)).toEqual(afterFirst);

    await expectDecryptedAtProviders(orgRepo, id);
  });
});
