import { INVALID_WHERE_VALUES_BEHAVIOR } from '../../config/where-values';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { Order, Organization } from '../../database/entities';
import { saveOrderWithNumbers } from '../orders/order-numbering';
import { CronLockService } from '../../common/redis/cron-lock.service';
import { DeploymentService } from '../../common/services/deployment.service';
import { EmailService } from '../email/email.service';
import { EventPhaseService } from '../events/event-phase.service';
import { EventNotificationsService } from './event-notifications.service';

/**
 * Erinnerungen zu Veranstaltungen gegen ein echtes Postgres: Merker,
 * Nachholen, Verschieben, Schalter, Empfaenger und Zahlen nach dem Fest.
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://openeos@127.0.0.1:5432/openeos_reminders_scratch pnpm test
 *
 * Datenbankname muss auf `_test` oder `_scratch` enden.
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

// Fest 16.–17.11.2026 (reine Daten): Verkauf 15.11. 18:00 bis 18.11. 12:00
const START = '2026-11-15T23:00:00.000Z';
const END = '2026-11-16T23:00:00.000Z';
const NOT_BOOKED = new Date('2026-11-06T09:20:00Z');
const WEEK_BEFORE = new Date('2026-11-09T09:20:00Z');
const DAY_BEFORE = new Date('2026-11-15T09:20:00Z');
const AFTER = new Date('2026-11-18T12:20:00Z');

describeWithDb('Event reminders against Postgres', () => {
  let ds: DataSource;
  const orgIds: string[] = [];
  const userIds: string[] = [];
  let sendEmail: jest.Mock;

  function service(
    options: { billingEnabled?: boolean; failMail?: boolean } = {},
  ): EventNotificationsService {
    sendEmail = jest.fn().mockResolvedValue(!options.failMail);
    const email = {
      enabled: true,
      appUrl: 'https://app.example.org',
      sendEmail,
    } as unknown as EmailService;
    const config = {
      get: (key: string) =>
        key === 'OPERATOR_EMERGENCY_PHONE' ? '+49 151 000000' : undefined,
    } as unknown as ConfigService;
    const deployment = {
      billingEnabled: options.billingEnabled ?? true,
    } as DeploymentService;
    const phase = new EventPhaseService(
      config,
      deployment,
      ds.getRepository(Organization),
      ds.getRepository(Order),
    );
    return new EventNotificationsService(
      ds,
      email,
      phase,
      deployment,
      {} as CronLockService,
      config,
    );
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
      entities: [path.join(__dirname, '../../database/entities/*.entity.ts')],
      migrations: [path.join(__dirname, '../../database/migrations/*.ts')],
      migrationsRun: true,
      logging: false,
    });
    await ds.initialize();
  }, 120_000);

  afterAll(async () => {
    if (ds?.isInitialized) {
      if (orgIds.length) {
        await ds.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [
          orgIds,
        ]);
      }
      if (userIds.length) {
        await ds.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
          userIds,
        ]);
      }
      await ds.destroy();
    }
  });

  async function organization(
    options: {
      settings?: Record<string, unknown>;
      admins?: { email?: string; preferences?: object; active?: boolean }[];
      operatingMode?: string;
    } = {},
  ): Promise<string> {
    const orgId = randomUUID();
    orgIds.push(orgId);
    await ds.query(
      `INSERT INTO organizations (id, name, slug, support_pin, settings, country, operating_mode)
       VALUES ($1, 'Testverein', $2, '123456', $3, 'DE', $4)`,
      [
        orgId,
        `rem-${orgId}`,
        JSON.stringify({
          timezone: 'Europe/Berlin',
          currency: 'EUR',
          ...options.settings,
        }),
        options.operatingMode ?? 'cashless',
      ],
    );
    for (const admin of options.admins ?? [{}]) {
      const userId = randomUUID();
      userIds.push(userId);
      await ds.query(
        `INSERT INTO users (id, email, first_name, last_name, is_active, preferences)
         VALUES ($1, $2, 'Erika', 'Muster', $3, $4)`,
        [
          userId,
          admin.email ?? `admin-${userId}@example.org`,
          admin.active ?? true,
          JSON.stringify(
            admin.preferences ?? { notifications: { email: true, push: true } },
          ),
        ],
      );
      await ds.query(
        `INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1, $2, 'admin')`,
        [userId, orgId],
      );
    }
    // Ein Mitglied bekommt nie eine Erinnerung.
    const member = randomUUID();
    userIds.push(member);
    await ds.query(
      `INSERT INTO users (id, email, first_name, last_name) VALUES ($1, $2, 'Max', 'Mitglied')`,
      [member, `member-${member}@example.org`],
    );
    await ds.query(
      `INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1, $2, 'member')`,
      [member, orgId],
    );
    return orgId;
  }

  async function event(
    orgId: string,
    options: {
      name?: string;
      status?: string;
      billing?: string;
      start?: string;
      end?: string;
      createdAt?: Date;
    } = {},
  ): Promise<string> {
    const [row] = await ds.query<{ id: string }[]>(
      `INSERT INTO events (organization_id, name, status, billing_status, start_date, end_date, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        orgId,
        options.name ?? `Fest ${randomUUID().slice(0, 8)}`,
        options.status ?? 'active',
        options.billing ?? 'paid',
        options.start ?? START,
        options.end ?? END,
        options.createdAt ?? new Date('2026-10-01T10:00:00Z'),
      ],
    );
    return row.id;
  }

  async function markers(eventId: string) {
    return ds.query<
      {
        kind: string;
        schedule_key: string;
        status: string;
        recipients: number;
        skip_reason: string | null;
      }[]
    >(
      `SELECT kind, schedule_key, status, recipients, skip_reason
         FROM event_notifications WHERE event_id = $1 ORDER BY created_at`,
      [eventId],
    );
  }

  function mailsFor(
    eventName: string,
  ): { to: string; subject: string; text: string }[] {
    return sendEmail.mock.calls
      .map(([m]) => m as { to: string; subject: string; text: string })
      .filter(
        (m) => m.subject.includes(eventName) || m.text.includes(eventName),
      );
  }

  async function sale(
    orgId: string,
    eventId: string,
    options: {
      test?: boolean;
      cancelled?: boolean;
      items: [string, number, number][];
    },
  ): Promise<void> {
    const order = await saveOrderWithNumbers(
      ds.getRepository(Order),
      { organizationId: orgId, eventId, plannedTest: false },
      { total: 0 },
    );
    let total = 0;
    const [{ id: categoryId }] = await ds.query<{ id: string }[]>(
      `INSERT INTO categories (event_id, name) VALUES ($1, 'Essen') RETURNING id`,
      [eventId],
    );
    for (const [name, quantity, price] of options.items) {
      total += quantity * price;
      const [{ id: productId }] = await ds.query<{ id: string }[]>(
        `INSERT INTO products (event_id, category_id, name, price) VALUES ($1, $2, $3, $4) RETURNING id`,
        [eventId, categoryId, name, price],
      );
      await ds.query(
        `INSERT INTO order_items (order_id, product_id, category_id, product_name, category_name,
                                  quantity, unit_price, total_price, tax_rate)
         VALUES ($1, $2, $3, $4, 'Essen', $5, $6, $7, 19)`,
        [
          order.id,
          productId,
          categoryId,
          name,
          quantity,
          price,
          quantity * price,
        ],
      );
    }
    await ds.query(
      `UPDATE orders SET subtotal = $2, total = $2, is_test = $3, status = $4 WHERE id = $1`,
      [
        order.id,
        total,
        options.test === true,
        options.cancelled ? 'cancelled' : 'completed',
      ],
    );
  }

  it('Woche vorher: einmal je Termin an alle Admins, nie an Mitglieder', async () => {
    const orgId = await organization({ admins: [{}, {}] });
    const name = `Kerwe ${randomUUID().slice(0, 6)}`;
    const eventId = await event(orgId, { name });

    await service().run(WEEK_BEFORE);
    const first = mailsFor(name);
    expect(first).toHaveLength(2);
    expect(first[0].subject).toContain('Dein Fest rückt näher');
    expect(first.every((m) => !m.to.startsWith('member-'))).toBe(true);
    expect(await markers(eventId)).toEqual([
      expect.objectContaining({
        kind: 'week_before',
        schedule_key: '2026-11-16',
        status: 'sent',
        recipients: 2,
      }),
    ]);

    // Zweiter Lauf eine Stunde spaeter: nichts mehr.
    await service().run(new Date(WEEK_BEFORE.getTime() + 3600_000));
    expect(mailsFor(name)).toHaveLength(0);
  });

  it('Checkliste liest echte Daten (Kasse, Bedienungen, Produkte)', async () => {
    const orgId = await organization();
    const name = `Weinfest ${randomUUID().slice(0, 6)}`;
    const eventId = await event(orgId, { name });
    await ds.query(
      `INSERT INTO devices (organization_id, name, type, device_token, settings, status)
       VALUES ($1, 'Kasse 1', 'pos', $2, '{"waiterMode":"shared"}', 'verified')`,
      [orgId, `tok-${randomUUID()}`],
    );
    const [{ id: categoryId }] = await ds.query<{ id: string }[]>(
      `INSERT INTO categories (event_id, name) VALUES ($1, 'Getränke') RETURNING id`,
      [eventId],
    );
    await ds.query(
      `INSERT INTO products (event_id, category_id, name, price) VALUES ($1, $2, 'Wein', 4), ($1, $2, 'Wasser', 0)`,
      [eventId, categoryId],
    );

    await service().run(WEEK_BEFORE);
    const [mail] = mailsFor(name);
    expect(mail.text).toContain('[✓] Kassen verbunden');
    expect(mail.text).toContain('1 Kasse mit deiner Organisation');
    expect(mail.text).toContain('[✗] Bedienungen anlegen');
    expect(mail.text).toContain(
      '2 Produkte in dieser Veranstaltung. Eines hat noch keinen Preis.',
    );
    expect(mail.text).toContain('Kein Drucker eingerichtet');
  });

  it('nachholen: verpasste Woche-Mail geht bis 5 Tage vorher raus, danach nie', async () => {
    const orgId = await organization();
    const late = await event(orgId, {
      name: `Spaet ${randomUUID().slice(0, 6)}`,
    });
    await service().run(new Date('2026-11-10T14:00:00Z'));
    expect(await markers(late)).toHaveLength(1);

    const orgId2 = await organization();
    const tooLate = await event(orgId2);
    await service().run(new Date('2026-11-12T09:00:00Z'));
    expect(await markers(tooLate)).toHaveLength(0);
  });

  it('Verschieben auf einen spaeteren Tag: die Erinnerung kommt fuer den neuen Termin noch einmal', async () => {
    const orgId = await organization();
    const name = `Schuetzenfest ${randomUUID().slice(0, 6)}`;
    const eventId = await event(orgId, { name });
    await service().run(WEEK_BEFORE);
    expect(mailsFor(name)).toHaveLength(1);

    // Eine Woche spaeter: 23.–24.11.
    await ds.query(
      `UPDATE events SET start_date = $2, end_date = $3 WHERE id = $1`,
      [eventId, '2026-11-22T23:00:00.000Z', '2026-11-23T23:00:00.000Z'],
    );
    await service().run(new Date('2026-11-16T09:20:00Z'));
    expect(mailsFor(name)).toHaveLength(1);
    expect((await markers(eventId)).map((m) => m.schedule_key)).toEqual([
      '2026-11-16',
      '2026-11-23',
    ]);
  });

  it('Vortag: Verkaufsstart, Loeschen der Testbestellungen, Notfallnummer', async () => {
    const orgId = await organization();
    const name = `Maifest ${randomUUID().slice(0, 6)}`;
    await event(orgId, { name });
    await service().run(DAY_BEFORE);
    const [mail] = mailsFor(name);
    expect(mail.subject).toContain("Morgen geht's los");
    expect(mail.text).toContain('heute, 18:00 Uhr');
    expect(mail.text).toContain('Testbestellungen');
    expect(mail.text).toContain('+49 151 000000');
  });

  it('nach dem Fest: Zahlen ohne Test und Storno, Top 3; ohne Bestellungen kein Rueckblick', async () => {
    const orgId = await organization();
    const name = `Sommerfest ${randomUUID().slice(0, 6)}`;
    const eventId = await event(orgId, { name });
    await sale(orgId, eventId, {
      items: [
        ['Bratwurst', 3, 3.5],
        ['Bier', 2, 4],
      ],
    });
    await sale(orgId, eventId, {
      items: [
        ['Bratwurst', 1, 3.5],
        ['Pommes', 1, 3],
      ],
    });
    await sale(orgId, eventId, { items: [['Kuchen', 9, 2]], test: true });
    await sale(orgId, eventId, { items: [['Kuchen', 9, 2]], cancelled: true });

    await service().run(AFTER);
    const [mail] = mailsFor(name);
    const text = mail.text.replace(/\u00a0/g, ' ');
    expect(text).toContain('Bestellungen: 2');
    expect(text).toContain('Umsatz: 25,00 €');
    expect(text).toContain('Verkaufte Artikel: 7');
    expect(text).toContain('1. Platz: Bratwurst · 4 Stück · 14,00 €');
    expect(text).not.toContain('Kuchen');

    const emptyOrg = await organization();
    const empty = await event(emptyOrg);
    await service().run(AFTER);
    expect(await markers(empty)).toEqual([
      expect.objectContaining({
        kind: 'after_event',
        status: 'skipped',
        skip_reason: 'no_orders',
      }),
    ]);
  });

  it('„Nur Bons“: Rueckblick nur mit Mengen', async () => {
    const orgId = await organization({ operatingMode: 'orders_only' });
    const name = `Bonfest ${randomUUID().slice(0, 6)}`;
    const eventId = await event(orgId, { name });
    await sale(orgId, eventId, { items: [['Bratwurst', 3, 0]] });
    await service().run(AFTER);
    const [mail] = mailsFor(name);
    expect(mail.text).not.toContain('€');
    expect(mail.text).toContain('1. Platz: Bratwurst · 3 Stück');
  });

  it('Testmodus: „noch nicht freigeschaltet“ — nicht auf eigener Installation', async () => {
    const orgId = await organization();
    const name = `Testfest ${randomUUID().slice(0, 6)}`;
    const eventId = await event(orgId, {
      name,
      status: 'test',
      billing: 'none',
    });

    await service({ billingEnabled: false }).run(NOT_BOOKED);
    expect(mailsFor(name)).toHaveLength(0);

    await service().run(NOT_BOOKED);
    const [mail] = mailsFor(name);
    expect(mail.subject).toContain('ist noch nicht freigeschaltet');
    expect(mail.text).toContain(`/events?unlock=${eventId}`);
    // Zehn Tage vorher laeuft die kostenlose Stornofrist noch.
    expect(mail.text).toContain(
      'Kostenlos stornieren kannst du bis 7 Tage vor Beginn, also bis Sonntag, 8. November 2026, 24:00 Uhr',
    );

    // Zur Woche vorher kommt keine zweite Mahnung.
    await service().run(WEEK_BEFORE);
    expect(mailsFor(name)).toHaveLength(0);
  });

  it('Schalter: Organisation aus → keine Mail und kein Merker; Admin abgemeldet → nur die anderen', async () => {
    const off = await organization({
      settings: { eventReminders: { weekBefore: false } },
    });
    const offEvent = await event(off);
    await service().run(WEEK_BEFORE);
    expect(await markers(offEvent)).toHaveLength(0);

    const mixed = await organization({
      admins: [
        {
          preferences: {
            notifications: { email: true, eventReminders: false },
          },
        },
        { preferences: { notifications: { email: false } } },
        { active: false },
        {},
      ],
    });
    const name = `Gemischt ${randomUUID().slice(0, 6)}`;
    await event(mixed, { name });
    await service().run(WEEK_BEFORE);
    expect(mailsFor(name)).toHaveLength(1);

    const nobody = await organization({
      admins: [{ preferences: { notifications: { email: false } } }],
    });
    const nobodyEvent = await event(nobody);
    await service().run(WEEK_BEFORE);
    expect(await markers(nobodyEvent)).toEqual([
      expect.objectContaining({
        status: 'skipped',
        skip_reason: 'no_recipients',
      }),
    ]);
  });

  it('geloeschte und inaktive Veranstaltungen: keine Erinnerung vor dem Fest', async () => {
    const orgId = await organization();
    const deleted = await event(orgId);
    await ds.query(`UPDATE events SET deleted_at = now() WHERE id = $1`, [
      deleted,
    ]);
    const inactive = await event(orgId, { status: 'inactive' });
    await service().run(WEEK_BEFORE);
    expect(await markers(deleted)).toHaveLength(0);
    expect(await markers(inactive)).toHaveLength(0);
  });

  it('mehrere Veranstaltungen einer Organisation laufen unabhaengig', async () => {
    // Nur eine aktive (oder Test-)Veranstaltung je Organisation; die
    // vorige ist vorbei und schon wieder inaktiv geschaltet.
    const orgId = await organization();
    const nextName = `Naechstes ${randomUUID().slice(0, 6)}`;
    const next = await event(orgId, { name: nextName });
    const pastName = `Voriges ${randomUUID().slice(0, 6)}`;
    const past = await event(orgId, {
      name: pastName,
      status: 'inactive',
      start: '2026-11-02T23:00:00.000Z',
      end: '2026-11-03T23:00:00.000Z',
    });
    await sale(orgId, past, { items: [['Kaffee', 2, 2]] });

    await service().run(WEEK_BEFORE);
    expect(mailsFor(nextName)[0].subject).toContain('Dein Fest rückt näher');
    expect(mailsFor(pastName)[0].subject).toContain('Danke! So lief dein Fest');
    expect((await markers(next)).map((m) => m.kind)).toEqual(['week_before']);
    expect((await markers(past)).map((m) => m.kind)).toEqual(['after_event']);
  });

  it('Versand scheitert an alle Empfaenger: Merker frei, naechster Lauf versucht es erneut', async () => {
    const orgId = await organization();
    const eventId = await event(orgId);
    await service({ failMail: true }).run(WEEK_BEFORE);
    expect(await markers(eventId)).toHaveLength(0);
    await service().run(new Date(WEEK_BEFORE.getTime() + 3600_000));
    expect(await markers(eventId)).toEqual([
      expect.objectContaining({ status: 'sent' }),
    ]);
  });

  it('zwei Laeufe gleichzeitig: trotzdem nur eine Mail', async () => {
    const orgId = await organization();
    const name = `Parallel ${randomUUID().slice(0, 6)}`;
    await event(orgId, { name });
    const one = service();
    const calls = sendEmail;
    const two = service();
    const callsTwo = sendEmail;
    await Promise.all([one.run(WEEK_BEFORE), two.run(WEEK_BEFORE)]);
    const subjects = [calls, callsTwo]
      .flatMap((mock) => mock.mock.calls as [{ subject: string }][])
      .map(([mail]) => mail.subject);
    const all = subjects.filter((subject) => subject.includes(name));
    expect(all).toHaveLength(1);
  });
});
