import { INVALID_WHERE_VALUES_BEHAVIOR } from '../../../config/where-values';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { legalConfigFromEnv } from '../../../config/legal.config';
import type { CronLockService } from '../../../common/redis/cron-lock.service';
import type { EmailService } from '../../email/email.service';
import { LegalService } from '../legal.service';
import { LegalAnnouncementMailer } from './legal-announcement-mailer.service';
import { LegalAnnouncementsService } from './legal-announcements.service';
import { addDays, berlinToday } from './legal-announcement.util';

/**
 * Ankuendigungen gegen ein echtes Postgres: Empfaenger (Admins, je Adresse
 * einmal), Versand hoechstens einmal (auch parallel und nach Abbruch),
 * Wiederholen, Hinweis und Ausblenden.
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://openeos@127.0.0.1:5432/openeos_legal_test pnpm test
 *
 * Datenbankname muss auf `_test` oder `_scratch` enden.
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

describeWithDb('Legal announcements against Postgres', () => {
  let ds: DataSource;
  const orgIds: string[] = [];
  const userIds: string[] = [];
  const tag = randomUUID().slice(0, 8);
  const mail = (name: string) => `${name}-${tag}@example.org`;

  let legal: LegalService;
  let sendEmail: jest.Mock;

  function services(options: { failFor?: string } = {}) {
    sendEmail = jest.fn((o: { to: string }) =>
      Promise.resolve(o.to !== options.failFor),
    );
    const email = {
      enabled: true,
      appUrl: 'https://app.example.org',
      sendEmail,
    } as unknown as EmailService;
    const config = new ConfigService({
      legal: legalConfigFromEnv(
        { LEGAL_SITE_URL: 'https://example.org' },
        false,
      ),
      platform: { contactEmail: 'hello@example.org' },
    });
    legal = new LegalService(
      ds.getRepository('LegalAcceptance') as never,
      ds,
      config,
      email,
    );
    const announcements = new LegalAnnouncementsService(
      ds,
      legal,
      email,
      config,
    );
    announcements.probe = () => Promise.resolve(200);
    const mailer = new LegalAnnouncementMailer(
      ds,
      email,
      legal,
      announcements,
      {} as CronLockService,
    );
    mailer.pauseMs = 0;
    return { announcements, mailer };
  }

  beforeAll(async () => {
    const name = new URL(TEST_DB!).pathname.replace(/^\//, '');
    if (!/_(test|scratch)$/.test(name)) {
      throw new Error(`Database "${name}" does not end in _test/_scratch`);
    }
    ds = new DataSource({
      invalidWhereValuesBehavior: INVALID_WHERE_VALUES_BEHAVIOR,
      type: 'postgres',
      url: TEST_DB,
      entities: [
        path.join(__dirname, '../../../database/entities/*.entity.ts'),
      ],
      migrations: [path.join(__dirname, '../../../database/migrations/*.ts')],
      migrationsRun: true,
      logging: false,
    });
    await ds.initialize();
    await ds.query(`DELETE FROM legal_announcements`);

    // Zwei Organisationen; dieselbe Adresse ist in beiden Admin (einmal
    // mit Grossbuchstaben), dazu ein Mitglied, ein inaktiver Admin und
    // ein Admin einer geloeschten Organisation.
    const user = async (email: string, active = true) => {
      const id = randomUUID();
      userIds.push(id);
      await ds.query(
        `INSERT INTO users (id, email, first_name, last_name, is_active) VALUES ($1, $2, 'Erika', 'Muster', $3)`,
        [id, email, active],
      );
      return id;
    };
    const org = async (deleted = false) => {
      const id = randomUUID();
      orgIds.push(id);
      await ds.query(
        `INSERT INTO organizations (id, name, slug, support_pin, settings, country, deleted_at)
         VALUES ($1, 'Testverein', $2, '123456', '{}', 'DE', $3)`,
        [id, `legal-${id}`, deleted ? new Date() : null],
      );
      return id;
    };
    const link = (userId: string, orgId: string, role: string) =>
      ds.query(
        `INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1, $2, $3)`,
        [userId, orgId, role],
      );
    const a = await org();
    const b = await org();
    const gone = await org(true);
    const both = await user(mail('both'));
    const bothUpper = await user(mail('BOTH').replace('both', 'Both'));
    await link(both, a, 'admin');
    await link(bothUpper, b, 'admin');
    await link(await user(mail('admin-b')), b, 'admin');
    await link(await user(mail('member')), a, 'member');
    await link(await user(mail('inactive'), false), a, 'admin');
    await link(await user(mail('gone')), gone, 'admin');
  }, 120_000);

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.query(`DELETE FROM legal_announcements`);
      await ds.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [
        orgIds,
      ]);
      await ds.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
      await ds.destroy();
    }
  });

  const mine = (emails: string[]) =>
    emails.filter((e) => e.toLowerCase().endsWith(`-${tag}@example.org`));
  const sentTo = () =>
    mine(
      (sendEmail.mock.calls as [{ to: string }][]).map(
        ([options]) => options.to,
      ),
    );
  const version = () => addDays(berlinToday(), 60);

  it('records acceptance of Anlage 1 next to the AGB and AVV', async () => {
    services();
    const id = randomUUID();
    userIds.push(id);
    await ds.query(
      `INSERT INTO users (id, email, first_name, last_name, is_active) VALUES ($1, $2, 'Erika', 'Muster', true)`,
      [id, mail('anlage1')],
    );
    await legal.accept(
      { id, email: mail('anlage1') },
      { documents: ['agb', 'avv', 'anlage1'], context: 'registration' },
    );
    const rows = await ds.query<{ document: string }[]>(
      `SELECT document FROM legal_acceptances WHERE user_id = $1 ORDER BY document`,
      [id],
    );
    expect(rows.map((r) => r.document)).toEqual(['agb', 'anlage1', 'avv']);
  });

  it('queues one mail per admin address and sends each exactly once', async () => {
    const { announcements, mailer } = services();
    const created = await announcements.create(
      {
        documents: ['agb', 'avv'],
        version: version(),
        summaryDe: 'Ziffer 5 wird klarer gefasst.',
        // Vom AVV nur Anhang B/C: keine Zustimmung noetig (AVV 6.3, 12.4).
        avvAnnexesOnly: true,
      },
      { id: userIds[0], email: 'super@example.org' },
    );
    expect(created.avvAnnexesOnly).toBe(true);
    expect(created.previousVersions).toEqual({
      agb: legal.config.versions.agb,
      avv: legal.config.versions.avv,
    });
    const queued: { email: string }[] = await ds.query(
      `SELECT email FROM legal_announcement_deliveries WHERE announcement_id = $1`,
      [created.id],
    );
    expect(mine(queued.map((q) => q.email.toLowerCase())).sort()).toEqual(
      [mail('admin-b'), mail('both')].sort(),
    );

    // Zwei Laeufe gleichzeitig (zwei Instanzen), dann noch einer.
    const other = services();
    sendEmail = jest.fn().mockResolvedValue(true);
    const calls: string[] = [];
    const record = jest.fn((o: { to: string }) => {
      calls.push(o.to);
      return Promise.resolve(true);
    });
    (
      mailer as unknown as { emailService: { sendEmail: jest.Mock } }
    ).emailService.sendEmail = record;
    (
      other.mailer as unknown as { emailService: { sendEmail: jest.Mock } }
    ).emailService.sendEmail = record;
    await Promise.all([
      mailer.processBatch(500),
      other.mailer.processBatch(500),
    ]);
    await mailer.processBatch(500);
    expect(
      mine(calls)
        .map((e) => e.toLowerCase())
        .sort(),
    ).toEqual([mail('admin-b'), mail('both')].sort());

    const [mailArgs] = record.mock.calls[0] as [
      { subject: string; html: string; replyTo: string },
    ];
    expect(mailArgs.subject).toContain(
      'Neue Fassung: AGB und Auftragsverarbeitungsvertrag',
    );
    expect(mailArgs.replyTo).toBe('hello@example.org');
    expect(mailArgs.html).toContain(`https://example.org/agb/${version()}`);
    expect(mailArgs.html).toContain('Ziffer 6.3');

    const listed = (await announcements.list()).find(
      (a) => a.id === created.id,
    )!;
    expect(listed.stats.pending).toBe(0);
    expect(listed.stats.sent).toBe(listed.stats.total);
  });

  it('rejects a second announcement of the same version', async () => {
    const { announcements } = services();
    await expect(
      announcements.create(
        {
          documents: ['agb'],
          version: version(),
          summaryDe: 'Noch einmal dasselbe.',
        },
        { id: userIds[0], email: 'super@example.org' },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses to announce a version missing on the website', async () => {
    const { announcements } = services();
    announcements.probe = () => Promise.resolve(404);
    const preview = await announcements.preview(
      {
        documents: ['privacy'],
        version: addDays(berlinToday(), 3),
        summaryDe: 'Neuer Dienstleister.',
      },
      { email: 'super@example.org', firstName: 'Sam' },
    );
    expect(preview.valid).toBe(false);
    expect(preview.problems[0]).toMatchObject({
      field: 'website',
      document: 'privacy',
    });
    expect(preview.problems[0].message).toContain(
      `https://example.org/datenschutz/${addDays(berlinToday(), 3)}`,
    );
    expect(preview.html).toContain('Hallo Sam');
    await expect(
      announcements.create(
        {
          documents: ['privacy'],
          version: addDays(berlinToday(), 3),
          summaryDe: 'Neuer Dienstleister.',
        },
        { id: userIds[0], email: 'super@example.org' },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('never resends an interrupted mail by itself; retry is explicit', async () => {
    const { announcements, mailer } = services({ failFor: mail('admin-b') });
    const created = await announcements.create(
      {
        documents: ['privacy'],
        version: addDays(berlinToday(), 5),
        summaryDe: 'Neuer Dienstleister für Mails.',
      },
      { id: userIds[0], email: 'super@example.org' },
    );
    // Eine Zeile haengt seit 20 Minuten im Versand (Absturz).
    await ds.query(
      `UPDATE legal_announcement_deliveries
          SET status = 'sending', claimed_at = now() - interval '20 minutes'
        WHERE announcement_id = $1 AND lower(email) = $2`,
      [created.id, mail('both')],
    );
    const summary = await mailer.processBatch(500);
    expect(summary.interrupted).toBe(1);
    expect(sentTo()).toEqual([mail('admin-b')]);

    let listed = (await announcements.list()).find((a) => a.id === created.id)!;
    expect(listed.stats.failed).toBe(2);
    expect(listed.failures.map((f) => f.email.toLowerCase()).sort()).toEqual(
      [mail('admin-b'), mail('both')].sort(),
    );

    // Erneut einreihen: jetzt klappt alles.
    expect(await announcements.retryFailed(created.id)).toBe(2);
    const fresh = services();
    await fresh.mailer.processBatch(500);
    expect(
      sentTo()
        .map((e) => e.toLowerCase())
        .sort(),
    ).toEqual([mail('admin-b'), mail('both')].sort());
    listed = (await fresh.announcements.list()).find(
      (a) => a.id === created.id,
    )!;
    expect(listed.stats.failed).toBe(0);
    expect(listed.stats.sent).toBe(listed.stats.total);
  });

  it('shows upcoming changes to admins until they dismiss them', async () => {
    const { announcements } = services();
    await legal.refreshAnnouncements();
    const [bothId] = await ds
      .query(`SELECT id FROM users WHERE email = $1`, [mail('both')])
      .then((r: { id: string }[]) => r.map((x) => x.id));
    const [memberId] = await ds
      .query(`SELECT id FROM users WHERE email = $1`, [mail('member')])
      .then((r: { id: string }[]) => r.map((x) => x.id));

    const upcoming = await announcements.upcomingFor(bothId);
    expect(upcoming.length).toBe(2);
    const agb = upcoming.find((u) => u.documents.includes('agb'))!;
    expect(agb.links.agb).toMatchObject({
      versionUrl: `https://example.org/agb/${version()}`,
      previousUrl: `https://example.org/agb/${legal.config.versions.agb}`,
    });
    expect(await announcements.upcomingFor(memberId)).toEqual([]);

    await announcements.dismiss(bothId, agb.id);
    await announcements.dismiss(bothId, agb.id); // zweimal schadet nicht
    const after = await announcements.upcomingFor(bothId);
    expect(after.map((u) => u.id)).not.toContain(agb.id);
    expect(after.length).toBe(1);
  });
});
