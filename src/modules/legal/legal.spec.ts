import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ConfigService } from '@nestjs/config';

import {
  legalConfigFromEnv,
  legalLinks,
  siteUrlFromAppUrl,
} from '../../config/legal.config';
import { RegisterDto } from '../auth/dto/register.dto';
import { acceptanceRows, LegalService } from './legal.service';

/*
 * Rechtstexte: Fassungen aus der Umgebung, Links auf Website und PDF,
 * Annahme-Status (erneute Annahme fuer Admins) und die Pflicht-Haken der
 * Registrierung.
 */

describe('legal config', () => {
  it('derives the website from the app URL (staging and production)', () => {
    expect(siteUrlFromAppUrl('https://app.staging.openeos.de')).toBe(
      'https://staging.openeos.de',
    );
    expect(siteUrlFromAppUrl('https://app.openeos.de/')).toBe(
      'https://openeos.de',
    );
    expect(siteUrlFromAppUrl('http://localhost:3000')).toBeNull();
    expect(siteUrlFromAppUrl(undefined)).toBeNull();
  });

  it('prefers LEGAL_SITE_URL and falls back to openeos.de', () => {
    expect(
      legalConfigFromEnv(
        {
          LEGAL_SITE_URL: 'https://example.org/',
          APP_URL: 'https://app.openeos.de',
        },
        false,
      ).siteUrl,
    ).toBe('https://example.org');
    expect(
      legalConfigFromEnv({ APP_URL: 'http://localhost:3000' }, false).siteUrl,
    ).toBe('https://openeos.de');
  });

  it('reads versions and ignores malformed ones', () => {
    const config = legalConfigFromEnv(
      { LEGAL_AGB_VERSION: '2027-01-15', LEGAL_AVV_VERSION: 'neu' },
      false,
    );
    expect(config.versions.agb).toBe('2027-01-15');
    expect(config.versions.avv).toBe('2026-11-04');
    expect(config.enabled).toBe(true);
    expect(legalConfigFromEnv({}, true).enabled).toBe(false);
  });

  it('builds page, archive and PDF links', () => {
    expect(
      legalLinks({ siteUrl: 'https://openeos.de' }, 'privacy', '2026-11-04'),
    ).toEqual({
      version: '2026-11-04',
      url: 'https://openeos.de/datenschutz',
      versionUrl: 'https://openeos.de/datenschutz/2026-11-04',
      pdfUrl: 'https://openeos.de/rechtstexte/datenschutz-2026-11-04.pdf',
    });
  });
});

describe('RegisterDto — required confirmations', () => {
  const base = {
    email: 'neu@example.org',
    firstName: 'Nina',
    lastName: 'Neu',
    organizationName: 'TSV Musterstadt',
    country: 'DE',
  };
  const errorsOf = async (extra: Record<string, unknown>) =>
    (await validate(plainToInstance(RegisterDto, { ...base, ...extra }))).map(
      (e) => e.property,
    );

  it('requires both boxes', async () => {
    expect(await errorsOf({})).toEqual(
      expect.arrayContaining(['acceptTerms', 'confirmBusiness']),
    );
    expect(
      await errorsOf({ acceptTerms: true, confirmBusiness: false }),
    ).toEqual(['confirmBusiness']);
    expect(
      await errorsOf({ acceptTerms: true, confirmBusiness: true }),
    ).toEqual([]);
  });
});

describe('acceptanceRows', () => {
  it('writes one row per document with version, IP and user agent', () => {
    const rows = acceptanceRows({
      config: legalConfigFromEnv({ LEGAL_AVV_VERSION: '2026-12-01' }, false),
      user: { id: 'u1', email: 'a@b.de' },
      organization: { id: 'o1', name: 'TSV' },
      documents: ['agb', 'avv'],
      context: 'registration',
      businessConfirmed: true,
      client: { ip: '203.0.113.7', userAgent: 'Firefox' },
    });
    expect(rows).toEqual([
      expect.objectContaining({
        document: 'agb',
        version: '2026-11-04',
        organizationId: 'o1',
        businessConfirmed: true,
        ipAddress: '203.0.113.7',
        userAgent: 'Firefox',
        context: 'registration',
      }),
      expect.objectContaining({ document: 'avv', version: '2026-12-01' }),
    ]);
  });
});

describe('LegalService.status / accept', () => {
  function setup(opts: {
    rows: { document: string; version: string; acceptedAt: Date }[];
    adminOrgs: { id: string; name: string }[];
    env?: Record<string, string>;
    selfHosted?: boolean;
  }) {
    const inserted: unknown[] = [];
    const qb = {
      distinctOn: () => qb,
      where: () => qb,
      orderBy: () => qb,
      addOrderBy: () => qb,
      getMany: () => Promise.resolve(opts.rows),
    };
    const repo = {
      createQueryBuilder: () => qb,
      insert: jest.fn((rows: unknown[]) => {
        inserted.push(...rows);
        return Promise.resolve({});
      }),
    };
    const dataSource = {
      query: jest.fn(() => Promise.resolve(opts.adminOrgs)),
    };
    const config = new ConfigService({
      legal: legalConfigFromEnv(
        { APP_URL: 'https://app.staging.openeos.de', ...(opts.env ?? {}) },
        opts.selfHosted ?? false,
      ),
    });
    const service = new LegalService(
      repo as never,
      dataSource as never,
      config,
      {} as never,
    );
    return { service, inserted };
  }

  it('requires acceptance from admins without any record (existing accounts)', async () => {
    const { service } = setup({
      rows: [],
      adminOrgs: [{ id: 'o1', name: 'TSV' }],
    });
    const status = await service.status('u1');
    expect(status.required).toBe(true);
    expect(status.documents.agb).toMatchObject({
      currentVersion: '2026-11-04',
      acceptedVersion: null,
      upToDate: false,
    });
  });

  it('is satisfied by the current versions and links the accepted one', async () => {
    const at = new Date('2026-11-04T10:00:00Z');
    const { service } = setup({
      rows: [
        { document: 'agb', version: '2026-11-04', acceptedAt: at },
        { document: 'avv', version: '2026-11-04', acceptedAt: at },
      ],
      adminOrgs: [{ id: 'o1', name: 'TSV' }],
    });
    const status = await service.status('u1');
    expect(status.required).toBe(false);
    expect(status.documents.avv).toMatchObject({
      upToDate: true,
      acceptedAt: at.toISOString(),
      acceptedUrl: 'https://staging.openeos.de/avv/2026-11-04',
      acceptedPdfUrl:
        'https://staging.openeos.de/rechtstexte/avv-2026-11-04.pdf',
    });
  });

  it('asks again when a newer version is published', async () => {
    const at = new Date('2026-11-04T10:00:00Z');
    const { service } = setup({
      rows: [
        { document: 'agb', version: '2026-11-04', acceptedAt: at },
        { document: 'avv', version: '2026-11-04', acceptedAt: at },
      ],
      adminOrgs: [{ id: 'o1', name: 'TSV' }],
      env: { LEGAL_AGB_VERSION: '2027-02-01' },
    });
    const status = await service.status('u1');
    expect(status.required).toBe(true);
    expect(status.documents.agb.upToDate).toBe(false);
    expect(status.documents.avv.upToDate).toBe(true);
  });

  it('does not ask plain members or self-hosted installs', async () => {
    expect(
      (await setup({ rows: [], adminOrgs: [] }).service.status('u1')).required,
    ).toBe(false);
    expect(
      await setup({
        rows: [],
        adminOrgs: [{ id: 'o1', name: 'TSV' }],
        selfHosted: true,
      }).service.isReacceptanceRequired('u1'),
    ).toBe(false);
  });

  it('records one row per admin organization and document', async () => {
    const { service, inserted } = setup({
      rows: [],
      adminOrgs: [
        { id: 'o1', name: 'TSV' },
        { id: 'o2', name: 'FC' },
      ],
    });
    await service.accept(
      { id: 'u1', email: 'a@b.de' },
      { context: 'reacceptance' },
      { ip: '198.51.100.1', userAgent: 'Safari' },
    );
    expect(inserted).toHaveLength(4);
    expect(inserted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          organizationId: 'o2',
          document: 'avv',
          context: 'reacceptance',
          ipAddress: '198.51.100.1',
        }),
      ]),
    );
  });
});
