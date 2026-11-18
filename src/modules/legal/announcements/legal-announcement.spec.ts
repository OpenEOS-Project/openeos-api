import { ConfigService } from '@nestjs/config';

import {
  DEFAULT_LEGAL_VERSIONS,
  LEGAL_INITIAL_VERSION,
  legalConfigFromEnv,
} from '../../../config/legal.config';
import { LegalService } from '../legal.service';
import {
  announcementSubject,
  legalAnnouncementMail,
  type AnnouncementMailInput,
} from './legal-announcement-mail';
import {
  addDays,
  type AnnouncementContext,
  berlinToday,
  effectiveLegalVersions,
  isValidVersion,
  validateAnnouncement,
} from './legal-announcement.util';

/*
 * Ankuendigung neuer Fassungen: welche Fassung gilt, Pruefung der
 * Ankuendigung (Frist, Reihenfolge, Ausgangsfassung) und die Mail.
 */

const BASE = { ...DEFAULT_LEGAL_VERSIONS, imprint: '2026-11-12' };

describe('dates', () => {
  it('uses the calendar day in Berlin', () => {
    // 23:30 UTC am 31.12. ist in Berlin schon der 1.1.
    expect(berlinToday(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
    expect(berlinToday(new Date('2026-11-18T10:00:00Z'))).toBe('2026-11-18');
  });

  it('adds calendar days and checks real dates', () => {
    expect(addDays('2026-11-18', 42)).toBe('2026-12-30');
    expect(addDays('2027-02-27', 2)).toBe('2027-03-01');
    expect(isValidVersion('2027-02-29')).toBe(false);
    expect(isValidVersion('2028-02-29')).toBe(true);
    expect(isValidVersion('2027-1-5')).toBe(false);
    expect(isValidVersion(undefined)).toBe(false);
  });
});

describe('effectiveLegalVersions', () => {
  const announced = [
    { documents: ['agb', 'avv'] as const, version: '2027-01-15' },
    { documents: ['privacy'] as const, version: '2026-12-01' },
  ];

  it('keeps the code versions before the effective date', () => {
    expect(effectiveLegalVersions(BASE, announced, '2026-11-30')).toEqual(BASE);
  });

  it('switches each document on its effective date', () => {
    expect(effectiveLegalVersions(BASE, announced, '2026-12-01').privacy).toBe(
      '2026-12-01',
    );
    const later = effectiveLegalVersions(BASE, announced, '2027-01-15');
    expect(later).toMatchObject({
      agb: '2027-01-15',
      avv: '2027-01-15',
      privacy: '2026-12-01',
      anlage1: BASE.anlage1,
      imprint: '2026-11-12',
    });
  });

  it('never goes back behind a newer code version', () => {
    expect(
      effectiveLegalVersions(
        { ...BASE, agb: '2027-03-01' },
        announced,
        '2027-04-01',
      ).agb,
    ).toBe('2027-03-01');
  });
});

describe('validateAnnouncement', () => {
  const context: AnnouncementContext = {
    today: '2026-11-18',
    current: BASE,
    initialVersion: LEGAL_INITIAL_VERSION,
    announced: [],
  };
  const valid = {
    documents: ['agb'],
    version: '2026-12-30',
    summaryDe: 'Ziffer 5 wird klarer gefasst.',
  };
  const fields = (problems: { field: string }[]) =>
    problems.map((p) => p.field);

  it('accepts an AGB change six weeks ahead', () => {
    expect(validateAnnouncement(valid, context)).toEqual([]);
  });

  it('requires six weeks for AGB, Anlage 1 and AVV', () => {
    for (const doc of ['agb', 'anlage1', 'avv']) {
      const problems = validateAnnouncement(
        {
          ...valid,
          documents: [doc],
          version: '2026-12-29',
          explicitConsent: true,
        },
        context,
      );
      expect(fields(problems)).toEqual(['version']);
      expect(problems[0].message).toContain('30.12.2026');
    }
  });

  it('requires consent for AVV changes (AVV 12.4)', () => {
    const problems = validateAnnouncement(
      { ...valid, documents: ['agb', 'avv'] },
      context,
    );
    expect(problems).toEqual([
      expect.objectContaining({ field: 'explicitConsent', document: 'avv' }),
    ]);
    expect(problems[0].message).toContain('AVV Ziffer 12.4');
    expect(
      validateAnnouncement(
        { ...valid, documents: ['agb', 'avv'], explicitConsent: true },
        context,
      ),
    ).toEqual([]);
    // Ohne AVV bleibt die Zustimmung freiwillig.
    expect(
      validateAnnouncement({ ...valid, documents: ['agb'] }, context),
    ).toEqual([]);
  });

  it('allows AVV annex B/C changes without consent four weeks ahead (AVV 6.3)', () => {
    const annex = { ...valid, documents: ['avv'], avvAnnexesOnly: true };
    // 18.11. + 28 Tage = 16.12.2026
    expect(
      validateAnnouncement({ ...annex, version: '2026-12-16' }, context),
    ).toEqual([]);
    const early = validateAnnouncement(
      { ...annex, version: '2026-12-15' },
      context,
    );
    expect(early).toEqual([
      expect.objectContaining({ field: 'version', document: 'avv' }),
    ]);
    expect(early[0].message).toContain('vier Wochen');
    expect(early[0].message).toContain('16.12.2026');
    expect(
      validateAnnouncement(
        { ...annex, version: '2026-11-25', shortNotice: true },
        context,
      ),
    ).toEqual([]);
  });

  it('keeps six weeks for AGB announced together with an AVV annex change', () => {
    const problems = validateAnnouncement(
      {
        ...valid,
        documents: ['agb', 'avv'],
        avvAnnexesOnly: true,
        version: '2026-12-16',
      },
      context,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain('AGB müssen mindestens sechs Wochen');
    expect(problems[0].message).not.toContain('Auftragsverarbeitungsvertrag');
  });

  it('accepts the annex option only together with the AVV', () => {
    expect(
      fields(validateAnnouncement({ ...valid, avvAnnexesOnly: true }, context)),
    ).toEqual(['avvAnnexesOnly']);
  });

  it('allows a shorter period only with the explicit flag', () => {
    expect(
      validateAnnouncement(
        { ...valid, version: '2026-11-25', shortNotice: true },
        context,
      ),
    ).toEqual([]);
  });

  it('allows privacy and imprint changes on short notice', () => {
    expect(
      validateAnnouncement(
        { ...valid, documents: ['privacy', 'imprint'], version: '2026-11-19' },
        context,
      ),
    ).toEqual([]);
  });

  it('rejects today, the past and anything up to the initial version', () => {
    expect(
      fields(
        validateAnnouncement(
          { ...valid, documents: ['privacy'], version: '2026-11-18' },
          context,
        ),
      ),
    ).toContain('version');
    const baseline = validateAnnouncement(
      { ...valid, documents: ['privacy'], version: '2026-11-19' },
      { ...context, today: '2026-11-10', initialVersion: '2026-11-20' },
    );
    expect(baseline.map((p) => p.message).join(' ')).toContain(
      'Ausgangsfassung',
    );
  });

  it('must be later than the current and any announced version', () => {
    const current = validateAnnouncement(
      { ...valid, documents: ['privacy'], version: '2026-12-01' },
      { ...context, current: { ...BASE, privacy: '2026-12-05' } },
    );
    expect(current[0]).toMatchObject({ field: 'version', document: 'privacy' });

    const announced = validateAnnouncement(
      { ...valid, version: '2027-01-10' },
      {
        ...context,
        announced: [{ documents: ['agb'], version: '2027-01-15' }],
      },
    );
    expect(announced[0].message).toContain('schon angekündigt');
    expect(
      validateAnnouncement(
        { ...valid, version: '2027-01-20' },
        {
          ...context,
          announced: [{ documents: ['agb'], version: '2027-01-15' }],
        },
      ),
    ).toEqual([]);
  });

  it('checks documents and summaries', () => {
    expect(
      fields(
        validateAnnouncement(
          { ...valid, documents: [], summaryDe: 'kurz' },
          context,
        ),
      ),
    ).toEqual(['documents', 'summaryDe']);
    expect(
      fields(
        validateAnnouncement(
          { ...valid, documents: ['agb', 'terms'] },
          context,
        ),
      ),
    ).toEqual(['documents']);
    expect(
      fields(
        validateAnnouncement(
          { ...valid, summaryEn: 'x'.repeat(4001) },
          context,
        ),
      ),
    ).toEqual(['summaryEn']);
  });
});

describe('legalAnnouncementMail', () => {
  const input: AnnouncementMailInput = {
    to: 'admin@example.org',
    firstName: 'Nina',
    version: '2027-01-15',
    documents: [
      {
        document: 'agb',
        versionUrl: 'https://openeos.de/agb/2027-01-15',
        pdfUrl: 'https://openeos.de/rechtstexte/agb-2027-01-15.pdf',
        previousVersion: '2026-11-18',
        previousUrl: 'https://openeos.de/agb/2026-11-18',
      },
    ],
    summaryDe: 'Ziffer 5 <neu> & klarer.',
    summaryEn: null,
    shortNotice: false,
    explicitConsent: false,
    avvAnnexesOnly: false,
    contactEmail: 'hello@openeos.de',
    appUrl: 'https://app.openeos.de',
  };

  it('names documents and date in the subject', () => {
    expect(announcementSubject(['agb', 'avv', 'imprint'], '2027-01-15')).toBe(
      'Neue Fassung: AGB, Auftragsverarbeitungsvertrag und Impressum ab 15. Januar 2027',
    );
  });

  it('points out the right to object and its consequence for AGB changes', () => {
    const { html } = legalAnnouncementMail(input);
    expect(html).toContain('Dein Widerspruchsrecht');
    expect(html).toContain('gelten die Änderungen als angenommen');
    expect(html).toContain('innerhalb von sechs Wochen');
    expect(html).toContain('mailto:hello@openeos.de');
    expect(html).toContain('einem Monat zum Monatsende kündigen');
    expect(html).toContain('https://openeos.de/agb/2027-01-15');
    expect(html).toContain('https://openeos.de/agb/2026-11-18');
    expect(html).toContain('Hallo Nina');
    // Fremdtext entschaerft
    expect(html).toContain('Ziffer 5 &lt;neu&gt; &amp; klarer.');
  });

  it('asks for consent instead when the change needs it', () => {
    const { html } = legalAnnouncementMail({ ...input, explicitConsent: true });
    expect(html).toContain('Deine Zustimmung ist nötig');
    expect(html).not.toContain('als angenommen');
  });

  const avvDoc = {
    document: 'avv' as const,
    versionUrl: 'https://openeos.de/avv/2027-01-15',
    pdfUrl: 'https://openeos.de/rechtstexte/avv-2027-01-15.pdf',
    previousVersion: '2026-11-18',
    previousUrl: 'https://openeos.de/avv/2026-11-18',
  };

  it('uses the AVV 6.3 procedure when only annexes B/C of the AVV change', () => {
    const { html } = legalAnnouncementMail({
      ...input,
      documents: [avvDoc],
      avvAnnexesOnly: true,
    });
    expect(html).toContain('Anhang B (Unterauftragsverarbeiter)');
    expect(html).toContain('Ziffer 6.3');
    expect(html).toContain('innerhalb von vier Wochen');
    expect(html).toContain('gilt die Änderung als genehmigt');
    expect(html).toContain('innerhalb von zwei Wochen');
    expect(html).toContain('jede Seite den Nutzungsvertrag');
    expect(html).toContain('Ziffer 6.4');
    expect(html).toContain('nur Anhang B/C');
    expect(html).not.toContain('sechs Wochen');
    expect(html).not.toContain('Zustimmung ist nötig');
  });

  it('separates AGB and AVV annex objections when both change', () => {
    const { html } = legalAnnouncementMail({
      ...input,
      documents: [input.documents[0], avvDoc],
      avvAnnexesOnly: true,
    });
    expect(html).toContain('Dein Widerspruchsrecht: AGB');
    expect(html).toContain('gelten die Änderungen der AGB als angenommen');
    expect(html).toContain('innerhalb von sechs Wochen');
    expect(html).toContain(
      'Dein Widerspruchsrecht: Auftragsverarbeitungsvertrag',
    );
    expect(html).toContain('innerhalb von vier Wochen');
  });

  it('asks for consent for an AVV change that is not limited to annexes', () => {
    const { html } = legalAnnouncementMail({
      ...input,
      documents: [avvDoc],
      explicitConsent: true,
    });
    expect(html).toContain('Deine Zustimmung ist nötig');
    expect(html).not.toContain('Ziffer 6.3');
  });

  it('is informational for privacy and imprint only', () => {
    const { html } = legalAnnouncementMail({
      ...input,
      documents: [{ ...input.documents[0], document: 'privacy' }],
      summaryEn: 'Clearer wording.',
    });
    expect(html).not.toContain('Widerspruchsrecht');
    expect(html).toContain('Du musst nichts tun');
    expect(html).toContain('Summary in English');
  });
});

describe('LegalService with announcements', () => {
  afterEach(() => jest.useRealTimers());
  function service(
    rows: { document: string; version: string; acceptedAt: Date }[],
    announcements: Record<string, unknown>[],
  ) {
    const qb = {
      distinctOn: () => qb,
      where: () => qb,
      orderBy: () => qb,
      addOrderBy: () => qb,
      getMany: () => Promise.resolve(rows),
    };
    const dataSource = {
      query: jest.fn((sql: string) =>
        Promise.resolve(
          sql.includes('FROM legal_announcements')
            ? announcements
            : [{ id: 'o1', name: 'TSV' }],
        ),
      ),
    };
    return new LegalService(
      { createQueryBuilder: () => qb, insert: jest.fn() } as never,
      dataSource as never,
      new ConfigService({
        legal: legalConfigFromEnv({ APP_URL: 'https://app.openeos.de' }, false),
      }),
      {} as never,
    );
  }

  const announcement = (version: string, extra = {}) => ({
    id: 'a1',
    documents: ['agb'],
    version,
    summary_de: 'Ziffer 5 wird klarer.',
    summary_en: null,
    short_notice: false,
    explicit_consent: false,
    avv_annexes_only: false,
    created_at: new Date('2026-11-18T10:00:00Z'),
    ...extra,
  });
  const accepted = [
    {
      document: 'agb',
      version: '2026-11-18',
      acceptedAt: new Date('2026-11-18T10:00:00Z'),
    },
    {
      document: 'avv',
      version: '2026-11-18',
      acceptedAt: new Date('2026-11-18T10:00:00Z'),
    },
  ];

  it('does nothing while the announced version is not yet in force', async () => {
    const legal = service(accepted, [announcement('2999-01-01')]);
    await legal.refreshAnnouncements();
    expect(legal.config.versions.agb).toBe(DEFAULT_LEGAL_VERSIONS.agb);
    const status = await legal.status('u1');
    expect(status.required).toBe(false);
    expect(status.change).toBeNull();
  });

  it('makes the announced version current on its date and asks again', async () => {
    // Nur die Uhr vorstellen: 15.01.2027, 00:30 in Berlin.
    jest.useFakeTimers({
      now: new Date('2027-01-14T23:30:00Z'),
      doNotFake: [
        'nextTick',
        'setImmediate',
        'setTimeout',
        'setInterval',
        'queueMicrotask',
      ],
    });
    const legal = service(accepted, [announcement('2027-01-15')]);
    await legal.refreshAnnouncements();
    expect(legal.config.versions.agb).toBe('2027-01-15');
    expect(legal.versions().documents.agb.versionUrl).toBe(
      'https://openeos.de/agb/2027-01-15',
    );
    const status = await legal.status('u1');
    expect(status.required).toBe(true);
    expect(status.change).toMatchObject({
      version: '2027-01-15',
      documents: ['agb'],
      explicitConsent: false,
      announcedAt: '2026-11-18T10:00:00.000Z',
    });
  });

  /** Uhr auf den 15.01.2027, 00:30 in Berlin. */
  const onEffectiveDate = () =>
    jest.useFakeTimers({
      now: new Date('2027-01-14T23:30:00Z'),
      doNotFake: [
        'nextTick',
        'setImmediate',
        'setTimeout',
        'setInterval',
        'queueMicrotask',
      ],
    });
  const inserted = (legal: LegalService) =>
    (
      legal as unknown as { acceptances: { insert: jest.Mock } }
    ).acceptances.insert.mock.calls.flatMap(
      ([rows]: [{ document: string; version: string }[]]) =>
        rows.map((r) => `${r.document}@${r.version}`),
    );

  it('names per document what needs to be accepted again', async () => {
    onEffectiveDate();
    const legal = service(accepted, [announcement('2027-01-15')]);
    await legal.refreshAnnouncements();
    const status = await legal.status('u1');
    expect(status.documents.agb.reacceptanceRequired).toBe(true);
    expect(status.documents.avv.reacceptanceRequired).toBe(false);
    // Anlage 1 in der Ausgangsfassung: niemand wird gefragt, auch ohne Zeile.
    expect(status.documents.anlage1).toMatchObject({
      acceptedVersion: null,
      reacceptanceRequired: false,
    });
  });

  it('records only the documents that need it on re-acceptance', async () => {
    onEffectiveDate();
    const legal = service(accepted, [announcement('2027-01-15')]);
    await legal.refreshAnnouncements();
    await legal.accept({ id: 'u1', email: 'nina@example.org' }, {});
    expect(inserted(legal)).toEqual(['agb@2027-01-15']);
  });

  it('records nothing on re-acceptance when nothing is due', async () => {
    const legal = service(accepted, []);
    await legal.accept(
      { id: 'u1', email: 'nina@example.org' },
      { context: 'reacceptance' },
    );
    expect(inserted(legal)).toEqual([]);
  });

  it('records all documents, including Anlage 1, when booking', async () => {
    const legal = service(accepted, []);
    await legal.accept(
      { id: 'u1', email: 'nina@example.org' },
      { context: 'purchase' },
    );
    expect(inserted(legal)).toEqual([
      `agb@${DEFAULT_LEGAL_VERSIONS.agb}`,
      `avv@${DEFAULT_LEGAL_VERSIONS.avv}`,
      `anlage1@${DEFAULT_LEGAL_VERSIONS.anlage1}`,
    ]);
  });

  it('asks again for Anlage 1 alone when only Anlage 1 changed', async () => {
    onEffectiveDate();
    const legal = service(accepted, [
      announcement('2027-01-15', {
        documents: ['anlage1'],
        explicit_consent: true,
      }),
    ]);
    await legal.refreshAnnouncements();
    const status = await legal.status('u1');
    expect(status.required).toBe(true);
    expect(status.documents.anlage1.reacceptanceRequired).toBe(true);
    expect(status.documents.agb.reacceptanceRequired).toBe(false);
    expect(status.change).toMatchObject({
      documents: ['anlage1'],
      explicitConsent: true,
    });
    await legal.accept({ id: 'u1', email: 'nina@example.org' }, {});
    expect(inserted(legal)).toEqual(['anlage1@2027-01-15']);
  });

  it('passes the AVV annex procedure on to the dialog', async () => {
    onEffectiveDate();
    const legal = service(accepted, [
      announcement('2027-01-15', {
        documents: ['avv'],
        avv_annexes_only: true,
      }),
    ]);
    await legal.refreshAnnouncements();
    const status = await legal.status('u1');
    expect(status.documents.avv.reacceptanceRequired).toBe(true);
    expect(status.change).toMatchObject({
      documents: ['avv'],
      explicitConsent: false,
      avvAnnexesOnly: true,
    });
  });

  it('keeps the last known state when the table can not be read', async () => {
    const legal = service(accepted, []);
    (
      legal as unknown as { dataSource: { query: jest.Mock } }
    ).dataSource.query = jest.fn().mockRejectedValue(new Error('down'));
    await legal.refreshAnnouncements();
    expect(legal.config.versions.agb).toBe(DEFAULT_LEGAL_VERSIONS.agb);
  });
});
