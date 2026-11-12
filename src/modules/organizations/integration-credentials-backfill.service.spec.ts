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
  const removals: string[] = [];
  const query = jest.fn((sql: string, params: unknown[]) => {
    if (sql.includes('settings - $1::text[]')) {
      // Abschnitte entfernter Integrationen loeschen (removed-settings.util).
      const sections = params[0] as string[];
      const hit = rows.filter((r) => {
        const integrations = r.settings.integrations as Settings | undefined;
        const found =
          sections.some((s) => s in r.settings) ||
          (!!integrations && sections.some((s) => s in integrations));
        if (!found) return false;
        for (const s of sections) {
          delete r.settings[s];
          if (integrations) delete integrations[s];
        }
        return true;
      });
      removals.push(...hit.map((r) => r.id));
      return Promise.resolve([hit.map((r) => ({ id: r.id })), hit.length]);
    }
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
    removals,
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
      // Fruehere PayPal-Zugangsdaten (Anbindung seit 1.8 entfernt).
      id: 'org-paypal',
      settings: {
        currency: 'EUR',
        paypal: { clientId: 'pp_id', clientSecret: 'PAYPAL_PLAIN' },
        integrations: { sumup: { enabled: true }, paypal: { enabled: true } },
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

    expect(result).toEqual({
      removed: 1,
      encrypted: 2,
      reencrypted: 0,
      undecryptable: 0,
    });
    const sumup = rows[0].settings.sumup as Record<string, string>;
    expect(isEncryptedCredential(sumup.apiKey)).toBe(true);
    expect(isEncryptedCredential(sumup.affiliateKey)).toBe(true);
    expect(sumup.merchantCode).toBe('MC1');
    expect(ring.decrypt(sumup.apiKey)?.plaintext).toBe('sup_sk_PLAIN1234');
    expect(rows[2].settings).toEqual({ currency: 'EUR' });
  });

  it('deletes stored PayPal settings (integration removed)', async () => {
    const rows = legacyRows();
    const { dataSource, removals } = fakeDataSource(rows);

    await new IntegrationCredentialsBackfillService(dataSource).run(ring);

    expect(removals).toEqual(['org-paypal']);
    expect(rows[1].settings).toEqual({
      currency: 'EUR',
      integrations: { sumup: { enabled: true } },
    });
  });

  it('is idempotent: a second run writes nothing', async () => {
    const rows = legacyRows();
    const { dataSource, updates } = fakeDataSource(rows);
    const service = new IntegrationCredentialsBackfillService(dataSource);

    await service.run(ring);
    const afterFirst = structuredClone(rows);
    updates.length = 0;
    const second = await service.run(ring);

    expect(second).toEqual({
      removed: 0,
      encrypted: 0,
      reencrypted: 0,
      undecryptable: 0,
    });
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
      { id: 'o1', settings: { sumup: { apiKey: foreign } } },
    ];
    const { dataSource, updates } = fakeDataSource(rows);

    const result = await new IntegrationCredentialsBackfillService(
      dataSource,
    ).run(ring);

    expect(result.undecryptable).toBe(1);
    expect(updates).toEqual([]);
    expect(
      (rows[0].settings.sumup as Record<string, string>).apiKey,
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
