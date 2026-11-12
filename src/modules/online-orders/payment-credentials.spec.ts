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
import {
  Organization,
  OrganizationSettings,
} from '../../database/entities/organization.entity';
import { UserOrganization } from '../../database/entities/user-organization.entity';
import { organizationSettingsTransformer } from '../../database/transformers/organization-settings.transformer';
import { IntegrationCredentialsBackfillService } from '../organizations/integration-credentials-backfill.service';
import { SumUpApiService } from '../sumup/sumup-api.service';
import { SumUpService } from '../sumup/sumup.service';
import { RemovePayPalSettings1842900000000 } from '../../database/migrations/1842900000000-RemovePayPalSettings';

/**
 * SumUp bekommt die Zugangsdaten im Klartext, obwohl sie
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
// Fruehere PayPal-Zugangsdaten (Anbindung seit 1.8 entfernt): werden beim
// Laden und Speichern verworfen und vom Abgleich geloescht.
const LEGACY_PAYPAL = { clientId: 'pp_client_id', clientSecret: 'SECRET_XYZ' };

function plainSettings(): OrganizationSettings {
  return {
    currency: 'EUR',
    timezone: 'Europe/Berlin',
    locale: 'de',
    sumup: { apiKey: SUMUP_KEY, merchantCode: 'MC123' },
    integrations: { sumup: { enabled: true } },
  } as OrganizationSettings;
}

function legacySettings(): Record<string, unknown> {
  return {
    ...plainSettings(),
    paypal: LEGACY_PAYPAL,
    integrations: { sumup: { enabled: true }, paypal: { enabled: true } },
  };
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
    };
    expect(isEncryptedCredential(stored.sumup.apiKey)).toBe(true);

    await expectDecryptedAtProviders(repositoryReturning(stored), 'org-1');
  });

  it('with legacy plaintext credentials', async () => {
    await expectDecryptedAtProviders(
      repositoryReturning(plainSettings()),
      'org-1',
    );
  });
});

describe('removed PayPal settings', () => {
  it('are dropped when loading and never written', () => {
    const loaded = organizationSettingsTransformer.from(
      legacySettings(),
    ) as Record<string, unknown>;
    expect(loaded).not.toHaveProperty('paypal');
    expect(loaded.integrations).toEqual({ sumup: { enabled: true } });

    const written = organizationSettingsTransformer.to(
      legacySettings(),
    ) as Record<string, unknown>;
    expect(written).not.toHaveProperty('paypal');
    expect(written.integrations).toEqual({ sumup: { enabled: true } });
    expect(JSON.stringify(written)).not.toContain('SECRET_XYZ');
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
    expect(raw.sumup!.merchantCode).toBe('MC123');
    expect(JSON.stringify(raw)).not.toMatch(/REALSECRET/);

    const loaded = await orgRepo.findOneByOrFail({ id });
    expect(loaded.settings.sumup?.apiKey).toBe(SUMUP_KEY);
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
    expect(loaded.settings.sumup?.apiKey).toBe(SUMUP_KEY);

    await expectDecryptedAtProviders(orgRepo, id);
  });

  it('reads legacy plaintext and the backfill encrypts it once', async () => {
    const id = randomUUID();
    orgIds.push(id);
    await ds.query(
      `INSERT INTO organizations (id, name, slug, support_pin, settings)
       VALUES ($1, 'Altverein', $2, '123456', $3::jsonb)`,
      [id, `altverein-${id}`, JSON.stringify(legacySettings())],
    );

    expect((await orgRepo.findOneByOrFail({ id })).settings.sumup?.apiKey).toBe(
      SUMUP_KEY,
    );
    await expectDecryptedAtProviders(orgRepo, id);

    const backfill = new IntegrationCredentialsBackfillService(ds);
    const first = await backfill.run(getIntegrationKeyring());
    expect(first.encrypted).toBeGreaterThanOrEqual(1);
    expect(first.removed).toBeGreaterThanOrEqual(1);
    const afterFirst = await rawSettings(id);
    expect(isEncryptedCredential(afterFirst.sumup!.apiKey)).toBe(true);
    expect(afterFirst).not.toHaveProperty('paypal');
    expect(afterFirst.integrations).toEqual({ sumup: { enabled: true } });
    expect(JSON.stringify(afterFirst)).not.toContain('SECRET_XYZ');

    const second = await backfill.run(getIntegrationKeyring());
    expect(second).toEqual({
      removed: 0,
      encrypted: 0,
      reencrypted: 0,
      undecryptable: 0,
    });
    expect(await rawSettings(id)).toEqual(afterFirst);

    await expectDecryptedAtProviders(orgRepo, id);
  });

  it('migration deletes stored PayPal settings, idempotently', async () => {
    const id = randomUUID();
    const other = randomUUID();
    orgIds.push(id, other);
    const legacy = organizationSettingsTransformer.to(plainSettings()) as Record<
      string,
      unknown
    >;
    await ds.query(
      `INSERT INTO organizations (id, name, slug, support_pin, settings)
       VALUES ($1, 'PayPal-Verein', $2, '123456', $3::jsonb),
              ($4, 'Ohne PayPal', $5, '123456', $6::jsonb)`,
      [
        id,
        `paypal-${id}`,
        JSON.stringify({
          ...legacy,
          paypal: { clientId: 'pp', clientSecret: 'enc:v1:abc' },
          integrations: { sumup: { enabled: true }, paypal: { enabled: true } },
        }),
        other,
        `ohne-${other}`,
        JSON.stringify({ currency: 'EUR', integrations: 'kaputt' }),
      ],
    );
    const migration = new RemovePayPalSettings1842900000000();
    const runner = ds.createQueryRunner();
    try {
      await migration.up(runner);
      const after = await rawSettings(id);
      expect(after).not.toHaveProperty('paypal');
      expect(after.integrations).toEqual({ sumup: { enabled: true } });
      expect(after.sumup).toEqual(legacy.sumup);
      const untouched = await rawSettings(other);
      await migration.up(runner);
      expect(await rawSettings(id)).toEqual(after);
      expect(await rawSettings(other)).toEqual(untouched);
      expect(untouched).toEqual({ currency: 'EUR', integrations: 'kaputt' });
    } finally {
      await runner.release();
    }
  });
});
