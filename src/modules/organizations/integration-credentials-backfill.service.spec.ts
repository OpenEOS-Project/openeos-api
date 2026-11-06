import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  IntegrationKeyring,
  isEncryptedCredential,
} from '../../common/services/integration-credentials.crypto';
import { IntegrationCredentialsBackfillService } from './integration-credentials-backfill.service';

const DEDICATED = 'dedicated-integration-key-for-tests-0123456789';
const TWO_FACTOR = 'two-factor-key-for-tests-0123456789abcdef';

type Settings = Record<string, unknown>;

/**
 * Nachbildung der beiden Abfragen des Abgleichs auf einer Tabelle im
 * Speicher — auch die Bedingung „Feld hat noch den gelesenen Wert“.
 */
function fakeDataSource(rows: { id: string; settings: Settings }[]) {
  const updates: string[] = [];
  let beforeUpdate: (() => void) | undefined;
  const query = jest.fn((sql: string, params: unknown[]) => {
    if (sql.startsWith('SELECT')) {
      const sections = params[0] as string[];
      return Promise.resolve(
        rows
          .filter((r) => sections.some((s) => s in r.settings))
          .map((r) => ({ id: r.id, settings: structuredClone(r.settings) })),
      );
    }
    beforeUpdate?.();
    beforeUpdate = undefined;
    const [id, section, field, next, expected] = params as string[];
    const row = rows.find((r) => r.id === id);
    const block = row?.settings[section] as Record<string, unknown> | undefined;
    if (!block || block[field] !== expected) {
      return Promise.resolve([[], 0]);
    }
    block[field] = next;
    updates.push(`${id}:${section}.${field}`);
    return Promise.resolve([[{ id }], 1]);
  });
  return {
    dataSource: { query } as unknown as DataSource,
    updates,
    onNextUpdate: (fn: () => void) => (beforeUpdate = fn),
  };
}

function legacyRows() {
  return [
    {
      id: 'org-sumup',
      settings: {
        currency: 'EUR',
        sumup: {
          apiKey: 'sup_sk_PLAIN1234',
          affiliateKey: 'aff_PLAIN5678',
          merchantCode: 'MC1',
        },
      },
    },
    {
      id: 'org-paypal',
      settings: {
        paypal: { clientId: 'pp_id', clientSecret: 'PAYPAL_PLAIN' },
      },
    },
    { id: 'org-none', settings: { currency: 'EUR' } },
  ];
}

describe('IntegrationCredentialsBackfillService', () => {
  const ring = new IntegrationKeyring({
    INTEGRATION_ENCRYPTION_KEY: DEDICATED,
    TWO_FACTOR_ENCRYPTION_KEY: TWO_FACTOR,
    NODE_ENV: 'production',
  });

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('encrypts plaintext credentials and leaves the rest alone', async () => {
    const rows = legacyRows();
    const { dataSource } = fakeDataSource(rows);
    const service = new IntegrationCredentialsBackfillService(dataSource);

    const result = await service.run(ring);

    expect(result).toEqual({ encrypted: 3, reencrypted: 0, undecryptable: 0 });
    const sumup = rows[0].settings.sumup as Record<string, string>;
    const paypal = rows[1].settings.paypal as Record<string, string>;
    expect(isEncryptedCredential(sumup.apiKey)).toBe(true);
    expect(isEncryptedCredential(sumup.affiliateKey)).toBe(true);
    expect(sumup.merchantCode).toBe('MC1');
    expect(isEncryptedCredential(paypal.clientSecret)).toBe(true);
    expect(paypal.clientId).toBe('pp_id');
    expect(ring.decrypt(sumup.apiKey)?.plaintext).toBe('sup_sk_PLAIN1234');
    expect(ring.decrypt(paypal.clientSecret)?.plaintext).toBe('PAYPAL_PLAIN');
    expect(rows[2].settings).toEqual({ currency: 'EUR' });
  });

  it('is idempotent: a second run writes nothing', async () => {
    const rows = legacyRows();
    const { dataSource, updates } = fakeDataSource(rows);
    const service = new IntegrationCredentialsBackfillService(dataSource);

    await service.run(ring);
    const afterFirst = structuredClone(rows);
    updates.length = 0;
    const second = await service.run(ring);

    expect(second).toEqual({ encrypted: 0, reencrypted: 0, undecryptable: 0 });
    expect(updates).toEqual([]);
    expect(rows).toEqual(afterFirst);
  });

  it('re-encrypts values written with the fallback key once a dedicated key is set', async () => {
    const before = new IntegrationKeyring({
      TWO_FACTOR_ENCRYPTION_KEY: TWO_FACTOR,
    });
    const oldValue = before.encrypt('sup_sk_OLD');
    const rows = [
      {
        id: 'o1',
        settings: { sumup: { apiKey: oldValue, merchantCode: 'M' } },
      },
    ];
    const { dataSource } = fakeDataSource(rows);

    const result = await new IntegrationCredentialsBackfillService(
      dataSource,
    ).run(ring);

    expect(result.reencrypted).toBe(1);
    const stored = (rows[0].settings.sumup as Record<string, string>).apiKey;
    expect(stored).not.toBe(oldValue);
    expect(ring.decrypt(stored)).toEqual({
      plaintext: 'sup_sk_OLD',
      current: true,
    });
  });

  it('counts but keeps values no key can open', async () => {
    const foreign = new IntegrationKeyring({
      INTEGRATION_ENCRYPTION_KEY: 'unknown-key-0123456789abcdef',
    }).encrypt('x');
    const rows = [
      { id: 'o1', settings: { paypal: { clientSecret: foreign } } },
    ];
    const { dataSource, updates } = fakeDataSource(rows);

    const result = await new IntegrationCredentialsBackfillService(
      dataSource,
    ).run(ring);

    expect(result.undecryptable).toBe(1);
    expect(updates).toEqual([]);
    expect(
      (rows[0].settings.paypal as Record<string, string>).clientSecret,
    ).toBe(foreign);
  });

  it('does not overwrite a key that was changed in the meantime', async () => {
    const rows = [
      {
        id: 'o1',
        settings: { sumup: { apiKey: 'sup_sk_PLAIN', merchantCode: 'M' } },
      },
    ];
    const { dataSource, onNextUpdate } = fakeDataSource(rows);
    const newer = ring.encrypt('sup_sk_NEW');
    onNextUpdate(() => {
      (rows[0].settings.sumup as Record<string, string>).apiKey = newer;
    });

    const result = await new IntegrationCredentialsBackfillService(
      dataSource,
    ).run(ring);

    expect(result.encrypted).toBe(0);
    expect((rows[0].settings.sumup as Record<string, string>).apiKey).toBe(
      newer,
    );
  });
});
