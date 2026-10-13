import { BadRequestException } from '@nestjs/common';

import type { Organization } from '../../../database/entities/organization.entity';
import {
  LEGAL_LIMITS,
  normalizeLegalSettings,
  toPublicLegalInfo,
} from './legal-settings.util';

function errorOf(fn: () => unknown): {
  reason?: string;
  details?: { field: string; code: string }[];
} {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse() as {
      reason?: string;
      details?: { field: string; code: string }[];
    };
  }
  throw new Error('expected normalizeLegalSettings to throw');
}

describe('normalizeLegalSettings', () => {
  it('keeps valid links and text, trims and drops empty fields', () => {
    expect(
      normalizeLegalSettings({
        imprintUrl: '  https://tsv-musterstadt.de/impressum ',
        imprintText: '',
        privacyUrl: null,
        privacyText: 'Verantwortlich:\r\nTSV Musterstadt e.V.\r\n',
        contactEmail: ' datenschutz@tsv-musterstadt.de ',
      }),
    ).toEqual({
      imprintUrl: 'https://tsv-musterstadt.de/impressum',
      privacyText: 'Verantwortlich:\nTSV Musterstadt e.V.',
      contactEmail: 'datenschutz@tsv-musterstadt.de',
    });
  });

  it('returns an empty object for null or an all-empty form', () => {
    expect(normalizeLegalSettings(null)).toEqual({});
    expect(
      normalizeLegalSettings({ imprintUrl: '', privacyText: '   ' }),
    ).toEqual({});
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,hi',
    'ftp://example.com/impressum',
    '/impressum',
    'tsv-musterstadt.de/impressum',
  ])('rejects the non-http(s) link %s', (url) => {
    const response = errorOf(() => normalizeLegalSettings({ imprintUrl: url }));
    expect(response.reason).toBe('ORGANIZATION_LEGAL_INVALID');
    expect(response.details).toEqual([
      expect.objectContaining({ field: 'legal.imprintUrl', code: 'url' }),
    ]);
  });

  it('rejects link and text for the same notice', () => {
    const response = errorOf(() =>
      normalizeLegalSettings({
        privacyUrl: 'https://example.org/datenschutz',
        privacyText: 'Text',
      }),
    );
    expect(response.details?.[0]).toMatchObject({
      field: 'legal.privacyText',
      code: 'linkOrText',
    });
  });

  it('enforces the length limits', () => {
    expect(
      errorOf(() =>
        normalizeLegalSettings({
          imprintText: 'x'.repeat(LEGAL_LIMITS.imprintText + 1),
        }),
      ).details?.[0],
    ).toMatchObject({ field: 'legal.imprintText', code: 'maxLength' });
    expect(
      errorOf(() =>
        normalizeLegalSettings({
          privacyUrl: `https://example.org/${'a'.repeat(LEGAL_LIMITS.url)}`,
        }),
      ).details?.[0],
    ).toMatchObject({ field: 'legal.privacyUrl', code: 'maxLength' });
    expect(
      normalizeLegalSettings({
        privacyText: 'x'.repeat(LEGAL_LIMITS.privacyText),
      }).privacyText,
    ).toHaveLength(LEGAL_LIMITS.privacyText);
  });

  it('rejects invalid e-mail addresses, unknown fields and wrong types', () => {
    expect(
      errorOf(() => normalizeLegalSettings({ contactEmail: 'kein-at' }))
        .details?.[0],
    ).toMatchObject({ field: 'legal.contactEmail', code: 'email' });
    expect(
      errorOf(() => normalizeLegalSettings({ html: '<b>x</b>' })).details?.[0],
    ).toMatchObject({ field: 'legal', code: 'unknownField' });
    expect(
      errorOf(() => normalizeLegalSettings({ imprintText: 42 })).details?.[0],
    ).toMatchObject({ field: 'legal.imprintText', code: 'type' });
    expect(
      errorOf(() => normalizeLegalSettings('https://example.org')).details?.[0],
    ).toMatchObject({ field: 'legal', code: 'type' });
  });

  it('strips control characters but keeps line breaks and tabs', () => {
    expect(
      normalizeLegalSettings({ imprintText: 'A\u0000B\u0007\n\tC' })
        .imprintText,
    ).toBe('AB\n\tC');
  });
});

describe('toPublicLegalInfo', () => {
  const platform = {
    imprintUrl: 'https://openeos.de/imprint',
    privacyUrl: 'https://openeos.de/privacy',
  };

  it('exposes only the legal fields, never other settings', () => {
    const organization = {
      name: 'TSV Musterstadt',
      settings: {
        currency: 'EUR',
        sumup: { apiKey: 'sup_sk_live_secret', merchantCode: 'MC1' },
        legal: {
          imprintUrl: 'https://tsv.example/impressum',
          privacyText: 'Datenschutz',
          contactEmail: 'ds@tsv.example',
        },
      },
    } as unknown as Organization;

    const info = toPublicLegalInfo(organization, platform);
    expect(info).toEqual({
      organizationName: 'TSV Musterstadt',
      imprintUrl: 'https://tsv.example/impressum',
      imprintText: null,
      privacyUrl: null,
      privacyText: 'Datenschutz',
      contactEmail: 'ds@tsv.example',
      complete: true,
      platform,
    });
    expect(JSON.stringify(info)).not.toContain('sup_sk_live_secret');
  });

  it('reports missing notices and drops unsafe stored links', () => {
    const info = toPublicLegalInfo(
      {
        name: 'Verein',
        settings: { legal: { imprintUrl: 'javascript:alert(1)' } },
      } as unknown as Organization,
      { imprintUrl: null, privacyUrl: '' as unknown as null },
    );
    expect(info).toMatchObject({
      imprintUrl: null,
      privacyUrl: null,
      complete: false,
      platform: { imprintUrl: null, privacyUrl: null },
    });
  });

  it('copes with organizations without settings', () => {
    expect(toPublicLegalInfo(null, platform)).toMatchObject({
      organizationName: '',
      complete: false,
    });
  });
});
