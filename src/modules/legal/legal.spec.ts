import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ConfigService } from '@nestjs/config';

import {
  DEFAULT_LEGAL_VERSIONS,
  isAfterInitialVersion,
  LEGAL_INITIAL_VERSION,
  legalConfigFromEnv,
  legalLinks,
  siteUrlFromAppUrl,
} from '../../config/legal.config';
import { RegisterDto } from '../auth/dto/register.dto';
import {
  acceptanceRows,
  LegalService,
  reacceptanceNeeded,
} from './legal.service';

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
    expect(config.versions.avv).toBe('2026-11-18');
    expect(config.versions.anlage1).toBe('2026-11-18');
    expect(config.reacceptanceEnabled).toBe(true);
    expect(config.initialVersion).toBe(LEGAL_INITIAL_VERSION);
    expect(
      legalConfigFromEnv({ LEGAL_REACCEPTANCE_ENABLED: 'FALSE' }, false)
        .reacceptanceEnabled,
    ).toBe(false);
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

describe('initial version (baseline)', () => {
  const config = (versions: Partial<typeof DEFAULT_LEGAL_VERSIONS>) => ({
    initialVersion: '2026-11-18',
    versions: { ...DEFAULT_LEGAL_VERSIONS, ...versions },
  });

  it('is the 2026-11-18 set', () => {
    expect(LEGAL_INITIAL_VERSION).toBe('2026-11-18');
    // Die eingebauten Fassungen loesen nie etwas aus.
    for (const version of Object.values(DEFAULT_LEGAL_VERSIONS)) {
      expect(isAfterInitialVersion(version)).toBe(false);
    }
  });

  it('only versions after it need announcement and re-acceptance', () => {
    expect(isAfterInitialVersion('2026-11-12', '2026-11-18')).toBe(false);
    expect(isAfterInitialVersion('2026-11-18', '2026-11-18')).toBe(false);
    expect(isAfterInitialVersion('2026-11-19', '2026-11-18')).toBe(true);
    expect(isAfterInitialVersion(null)).toBe(false);

    const initial = config({ agb: '2026-11-18' });
    expect(reacceptanceNeeded(initial, 'agb', null)).toBe(false);
    expect(reacceptanceNeeded(initial, 'agb', '2026-11-12')).toBe(false);

    const later = config({ agb: '2027-01-15' });
    expect(reacceptanceNeeded(later, 'agb', null)).toBe(true);
    expect(reacceptanceNeeded(later, 'agb', '2026-11-18')).toBe(true);
    expect(reacceptanceNeeded(later, 'agb', '2027-01-15')).toBe(false);
    expect(reacceptanceNeeded(later, 'avv', null)).toBe(false);
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
        version: '2026-11-18',
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

  it('never asks for versions up to the initial version (baseline)', async () => {
    // Konten aus der Testphase: aeltere Fassung oder gar keine Annahme.
    for (const rows of [
      [],
      [
        {
          document: 'agb',
          version: '2026-11-04',
          acceptedAt: new Date('2026-11-04T10:00:00Z'),
        },
      ],
    ]) {
      const { service } = setup({
        rows,
        adminOrgs: [{ id: 'o1', name: 'TSV' }],
        env: {
          LEGAL_AGB_VERSION: LEGAL_INITIAL_VERSION,
          LEGAL_AVV_VERSION: LEGAL_INITIAL_VERSION,
        },
      });
      expect((await service.status('u1')).required).toBe(false);
      expect(await service.isReacceptanceRequired('u1')).toBe(false);
    }
  });

  it('asks admins without any record once a later version is current', async () => {
    const { service } = setup({
      rows: [],
      adminOrgs: [{ id: 'o1', name: 'TSV' }],
      env: { LEGAL_AVV_VERSION: '2027-03-01' },
    });
    const status = await service.status('u1');
    expect(status.required).toBe(true);
    expect(status.documents.avv).toMatchObject({
      currentVersion: '2027-03-01',
      acceptedVersion: null,
      upToDate: false,
    });
  });

  it('can be switched off with LEGAL_REACCEPTANCE_ENABLED=false', async () => {
    const { service } = setup({
      rows: [],
      adminOrgs: [{ id: 'o1', name: 'TSV' }],
      env: {
        LEGAL_AGB_VERSION: '2027-03-01',
        LEGAL_REACCEPTANCE_ENABLED: 'false',
      },
    });
    expect((await service.status('u1')).required).toBe(false);
    expect(await service.isReacceptanceRequired('u1')).toBe(false);
  });

  it('is satisfied by the current versions and links the accepted one', async () => {
    const at = new Date('2026-11-04T10:00:00Z');
    const { service } = setup({
      rows: [
        { document: 'agb', version: '2026-11-18', acceptedAt: at },
        { document: 'avv', version: '2026-11-18', acceptedAt: at },
      ],
      adminOrgs: [{ id: 'o1', name: 'TSV' }],
      env: { LEGAL_REACCEPTANCE_ENABLED: 'true' },
    });
    const status = await service.status('u1');
    expect(status.required).toBe(false);
    expect(status.documents.avv).toMatchObject({
      upToDate: true,
      acceptedAt: at.toISOString(),
      acceptedUrl: 'https://staging.openeos.de/avv/2026-11-18',
      acceptedPdfUrl:
        'https://staging.openeos.de/rechtstexte/avv-2026-11-18.pdf',
    });
  });

  it('asks again when a newer version is published', async () => {
    const at = new Date('2026-11-04T10:00:00Z');
    const { service } = setup({
      rows: [
        { document: 'agb', version: '2026-11-18', acceptedAt: at },
        { document: 'avv', version: '2026-11-18', acceptedAt: at },
      ],
      adminOrgs: [{ id: 'o1', name: 'TSV' }],
      env: {
        LEGAL_AGB_VERSION: '2027-02-01',
      },
    });
    const status = await service.status('u1');
    expect(status.required).toBe(true);
    expect(status.documents.agb.upToDate).toBe(false);
    expect(status.documents.avv.upToDate).toBe(true);
  });

  it('lists Anlage 1 with the AGB and AVV in the legal mails', () => {
    const { service } = setup({ rows: [], adminOrgs: [] });
    const docs = service.emailDocuments();
    expect(docs.map((d) => d.label)).toEqual([
      'Allgemeine Geschäftsbedingungen (AGB)',
      'Auftragsverarbeitungsvertrag (AVV)',
      'Anlage 1 zu den AGB – Leistungsbeschreibung und Preisliste',
    ]);
    expect(docs[2]).toMatchObject({
      version: '2026-11-18',
      versionUrl: 'https://staging.openeos.de/leistungsbeschreibung/2026-11-18',
      pdfUrl:
        'https://staging.openeos.de/rechtstexte/leistungsbeschreibung-2026-11-18.pdf',
    });
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
