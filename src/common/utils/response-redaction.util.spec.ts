import { StreamableFile } from '@nestjs/common';

import {
  redactResponse,
  restoreMaskedCredentials,
} from './response-redaction.util';

describe('redactResponse', () => {
  it('entfernt Benutzer-Geheimnisse, auch tief in Relationen', () => {
    const organisation = {
      id: 'o1',
      userOrganizations: [
        {
          role: 'member',
          user: {
            id: 'u1',
            email: 'a@b.de',
            passwordHash: '$2b$12$abc',
            passwordResetToken: 'reset',
            emailVerificationToken: 'verify',
            twoFactorSecretEncrypted: 'enc',
            twoFactorBackupCodesHash: 'codes',
            pendingEmailToken: 'pending',
          },
        },
      ],
    };

    const user = redactResponse({ data: organisation }).data
      .userOrganizations[0].user as Record<string, unknown>;

    expect(user).toEqual({ id: 'u1', email: 'a@b.de' });
  });

  it('maskiert Zahlungs-Zugangsdaten und laesst den Rest stehen', () => {
    const settings = {
      currency: 'EUR',
      sumup: {
        apiKey: 'sup_sk_REALSECRET1234',
        affiliateKey: 'aff_5678',
        merchantCode: 'M1',
      },
      paypal: { clientId: 'pp_id', clientSecret: 'PAYPAL_SECRET_XYZ' },
    };

    const out = redactResponse({ settings }).settings;

    expect(out.currency).toBe('EUR');
    expect(out.sumup).toEqual({
      apiKey: '****1234',
      affiliateKey: '****5678',
      merchantCode: 'M1',
    });
    expect(out.paypal).toEqual({ clientId: 'pp_id', clientSecret: '****_XYZ' });
  });

  it('veraendert das Original nicht', () => {
    // Genau so war der SumUp-Schluessel in der Datenbank zu `****1234`
    // geworden: die Maske landete am Entity, und das wurde gespeichert.
    const entity = {
      settings: { sumup: { apiKey: 'sup_sk_REALSECRET1234' } },
      user: { passwordHash: 'hash' },
    };
    redactResponse(entity);
    expect(entity.settings.sumup.apiKey).toBe('sup_sk_REALSECRET1234');
    expect(entity.user.passwordHash).toBe('hash');
  });

  it('kommt mit Zyklen zurecht', () => {
    const org: Record<string, unknown> = { id: 'o1' };
    const membership = { organization: org };
    org.userOrganizations = [membership];

    const out = redactResponse(org);
    expect(out.id).toBe('o1');
  });

  it('laesst Dateien, Puffer und Datumswerte unangetastet', () => {
    const file = new StreamableFile(Buffer.from('%PDF'));
    const buffer = Buffer.from('x');
    const date = new Date('2026-01-01');

    expect(redactResponse(file)).toBe(file);
    expect(redactResponse(buffer)).toBe(buffer);
    expect(redactResponse({ at: date }).at).toBe(date);
  });
});

describe('restoreMaskedCredentials', () => {
  const stored = {
    sumup: { apiKey: 'sup_sk_REALSECRET1234', affiliateKey: 'aff_5678' },
    paypal: { clientId: 'pp_id', clientSecret: 'PAYPAL_SECRET_XYZ' },
  };

  it('setzt maskierte Werte auf den gespeicherten Schluessel zurueck', () => {
    const incoming = {
      sumup: {
        apiKey: '****1234',
        affiliateKey: '****5678',
        merchantCode: 'M2',
      },
      paypal: { clientId: 'pp_id', clientSecret: '****_XYZ' },
    };

    restoreMaskedCredentials(incoming, stored);

    expect(incoming.sumup.apiKey).toBe('sup_sk_REALSECRET1234');
    expect(incoming.sumup.affiliateKey).toBe('aff_5678');
    expect(incoming.sumup.merchantCode).toBe('M2');
    expect(incoming.paypal.clientSecret).toBe('PAYPAL_SECRET_XYZ');
  });

  it('uebernimmt neu eingegebene Schluessel', () => {
    const incoming = { sumup: { apiKey: 'sup_sk_NEWKEY9999' } };
    restoreMaskedCredentials(incoming, stored);
    expect(incoming.sumup.apiKey).toBe('sup_sk_NEWKEY9999');
  });

  it('speichert nie eine Maske, wenn nichts hinterlegt ist', () => {
    const incoming: { paypal: Record<string, unknown> } = {
      paypal: { clientSecret: '****abcd' },
    };
    restoreMaskedCredentials(incoming, {});
    expect(incoming.paypal).not.toHaveProperty('clientSecret');
  });
});
