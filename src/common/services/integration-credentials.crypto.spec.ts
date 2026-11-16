import { Logger } from '@nestjs/common';
import { Equal } from 'typeorm';

import { organizationSettingsTransformer } from '../../database/transformers/organization-settings.transformer';
import {
  redactResponse,
  restoreMaskedCredentials,
} from '../utils/response-redaction.util';
import {
  ENCRYPTED_CREDENTIAL_PREFIX,
  IntegrationKeyring,
  decryptCredentialSettings,
  encryptCredentialSettings,
  getIntegrationKeyring,
  isEncryptedCredential,
  resetIntegrationKeyring,
} from './integration-credentials.crypto';

const DEDICATED = 'dedicated-integration-key-for-tests-0123456789';
const TWO_FACTOR = 'two-factor-key-for-tests-0123456789abcdef';

function plainSettings() {
  return {
    currency: 'EUR',
    sumup: {
      apiKey: 'sup_sk_REALSECRET1234',
      affiliateKey: 'aff_SECRET5678',
      merchantCode: 'MC123',
      appId: 'app.openeos',
    },
    integrations: { sumup: { enabled: true } },
  };
}

describe('IntegrationKeyring', () => {
  it('roundtrips with a prefix and a fresh IV per value', () => {
    const ring = new IntegrationKeyring({
      INTEGRATION_ENCRYPTION_KEY: DEDICATED,
    });
    const a = ring.encrypt('sup_sk_REALSECRET1234');
    const b = ring.encrypt('sup_sk_REALSECRET1234');

    expect(a.startsWith(ENCRYPTED_CREDENTIAL_PREFIX)).toBe(true);
    expect(a).not.toContain('REALSECRET');
    expect(a).not.toBe(b);
    expect(ring.decrypt(a)).toEqual({
      plaintext: 'sup_sk_REALSECRET1234',
      current: true,
    });
    expect(ring.decrypt(b)?.plaintext).toBe('sup_sk_REALSECRET1234');
  });

  it('prefers INTEGRATION_ENCRYPTION_KEY and falls back to TWO_FACTOR_ENCRYPTION_KEY', () => {
    expect(
      new IntegrationKeyring({
        INTEGRATION_ENCRYPTION_KEY: DEDICATED,
        TWO_FACTOR_ENCRYPTION_KEY: TWO_FACTOR,
      }).source,
    ).toBe('INTEGRATION_ENCRYPTION_KEY');
    expect(
      new IntegrationKeyring({
        INTEGRATION_ENCRYPTION_KEY: '  ',
        TWO_FACTOR_ENCRYPTION_KEY: TWO_FACTOR,
      }).source,
    ).toBe('TWO_FACTOR_ENCRYPTION_KEY');
  });

  it('still reads values written with the fallback key after a dedicated key is set', () => {
    const before = new IntegrationKeyring({
      TWO_FACTOR_ENCRYPTION_KEY: TWO_FACTOR,
    });
    const after = new IntegrationKeyring({
      INTEGRATION_ENCRYPTION_KEY: DEDICATED,
      TWO_FACTOR_ENCRYPTION_KEY: TWO_FACTOR,
    });
    const value = before.encrypt('secret');

    expect(after.decrypt(value)).toEqual({
      plaintext: 'secret',
      current: false,
    });
  });

  it('returns null for a foreign key or damaged data', () => {
    const ring = new IntegrationKeyring({
      INTEGRATION_ENCRYPTION_KEY: DEDICATED,
      NODE_ENV: 'production',
    });
    const other = new IntegrationKeyring({
      INTEGRATION_ENCRYPTION_KEY: 'something-else-entirely-0123456789',
      NODE_ENV: 'production',
    });

    expect(ring.decrypt(other.encrypt('secret'))).toBeNull();
    expect(ring.decrypt(`${ENCRYPTED_CREDENTIAL_PREFIX}bm9wZQ==`)).toBeNull();
  });

  it('refuses to work without any key in production', () => {
    expect(() => new IntegrationKeyring({ NODE_ENV: 'production' })).toThrow(
      /INTEGRATION_ENCRYPTION_KEY/,
    );
  });

  it('uses a development default outside production', () => {
    const ring = new IntegrationKeyring({ NODE_ENV: 'development' });
    expect(ring.source).toBe('development-default');
    expect(ring.decrypt(ring.encrypt('x'))?.plaintext).toBe('x');
  });
});

describe('encrypt/decryptCredentialSettings', () => {
  const ring = new IntegrationKeyring({
    INTEGRATION_ENCRYPTION_KEY: DEDICATED,
  });

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('encrypts only the credential fields and leaves the input untouched', () => {
    const input = plainSettings();
    const stored = encryptCredentialSettings(input, ring);

    expect(input).toEqual(plainSettings());
    expect(isEncryptedCredential(stored.sumup.apiKey)).toBe(true);
    expect(isEncryptedCredential(stored.sumup.affiliateKey)).toBe(true);
    expect(stored.sumup.merchantCode).toBe('MC123');
    expect(stored.sumup.appId).toBe('app.openeos');
    expect(stored.integrations).toBe(input.integrations);
    expect(JSON.stringify(stored)).not.toMatch(/REALSECRET|SECRET5678/);

    expect(decryptCredentialSettings(stored, ring)).toEqual(plainSettings());
  });

  it('is idempotent: encrypted values are not encrypted twice', () => {
    const once = encryptCredentialSettings(plainSettings(), ring);
    const twice = encryptCredentialSettings(once, ring);

    expect(twice).toBe(once);
    expect(decryptCredentialSettings(twice, ring)).toEqual(plainSettings());
  });

  it('reads legacy plaintext unchanged', () => {
    const legacy = plainSettings();
    expect(decryptCredentialSettings(legacy, ring)).toBe(legacy);
  });

  it('keeps values it cannot decrypt instead of dropping them', () => {
    const foreign = new IntegrationKeyring({
      INTEGRATION_ENCRYPTION_KEY: 'another-key-0123456789abcdef',
      NODE_ENV: 'production',
    });
    const stored = encryptCredentialSettings(plainSettings(), foreign);
    const strict = new IntegrationKeyring({
      INTEGRATION_ENCRYPTION_KEY: DEDICATED,
      NODE_ENV: 'production',
    });

    const loaded = decryptCredentialSettings(stored, strict);
    expect(loaded.sumup.apiKey).toBe(stored.sumup.apiKey);
    // Speichern schreibt ihn unveraendert zurueck.
    expect(encryptCredentialSettings(loaded, strict).sumup.apiKey).toBe(
      stored.sumup.apiKey,
    );
  });

  it('passes through null, empty values and non-objects', () => {
    expect(encryptCredentialSettings(null, ring)).toBeNull();
    expect(encryptCredentialSettings(undefined, ring)).toBeUndefined();
    const empty = { sumup: { apiKey: '', merchantCode: 'M' } };
    expect(encryptCredentialSettings(empty, ring)).toBe(empty);
    const operator = Equal({ currency: 'EUR' });
    expect(encryptCredentialSettings(operator, ring)).toBe(operator);
  });
});

describe('organizationSettingsTransformer', () => {
  const env = { ...process.env };

  beforeEach(() => {
    process.env.INTEGRATION_ENCRYPTION_KEY = DEDICATED;
    resetIntegrationKeyring();
  });

  afterAll(() => {
    process.env = env;
    resetIntegrationKeyring();
  });

  it('uses the key from the environment', () => {
    expect(getIntegrationKeyring().source).toBe('INTEGRATION_ENCRYPTION_KEY');
    const stored = organizationSettingsTransformer.to(
      plainSettings(),
    ) as ReturnType<typeof plainSettings>;
    expect(
      new IntegrationKeyring({ INTEGRATION_ENCRYPTION_KEY: DEDICATED }).decrypt(
        stored.sumup.apiKey,
      )?.plaintext,
    ).toBe('sup_sk_REALSECRET1234');
  });

  it('masks the decrypted key in responses (last four characters of the real key)', () => {
    const stored = organizationSettingsTransformer.to(plainSettings());
    const entity = {
      id: 'o1',
      settings: organizationSettingsTransformer.from(stored) as ReturnType<
        typeof plainSettings
      >,
    };

    const out = redactResponse({ data: entity }).data.settings;

    expect(out.sumup).toEqual({
      apiKey: '****1234',
      affiliateKey: '****5678',
      merchantCode: 'MC123',
      appId: 'app.openeos',
    });
    expect(JSON.stringify(out)).not.toContain(ENCRYPTED_CREDENTIAL_PREFIX);
    // Antworten aendern das Entity nicht.
    expect(entity.settings.sumup.apiKey).toBe('sup_sk_REALSECRET1234');
  });

  it('restores a masked key on save and stores it encrypted', () => {
    const loaded = organizationSettingsTransformer.from(
      organizationSettingsTransformer.to(plainSettings()),
    ) as Record<string, unknown>;
    const incoming: Record<string, unknown> = {
      sumup: { apiKey: '****1234', merchantCode: 'MC999' },
    };

    restoreMaskedCredentials(incoming, loaded);
    const saved = organizationSettingsTransformer.to({
      ...loaded,
      ...incoming,
    }) as ReturnType<typeof plainSettings>;

    expect(isEncryptedCredential(saved.sumup.apiKey)).toBe(true);
    const reloaded = organizationSettingsTransformer.from(saved) as ReturnType<
      typeof plainSettings
    >;
    expect(reloaded.sumup.apiKey).toBe('sup_sk_REALSECRET1234');
    expect(reloaded.sumup.merchantCode).toBe('MC999');
  });
});
