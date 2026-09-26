import { randomUUID } from 'crypto';
import * as path from 'path';
import { DataSource, EntityManager, IsNull } from 'typeorm';

import {
  ContactRequest,
  Device,
  Event,
  Order,
  Organization,
  RentalAssignment,
  SupportMessage,
  User,
} from '../../database/entities';
import { MonitoringService } from './monitoring.service';
import {
  LISTEN_LAENGE,
  VORSCHAU_LAENGE,
  type Freischaltung,
  type Kennzahlen,
  type Kontaktanfrage,
  type NeueOrganisation,
  type NeuerNutzer,
} from './monitoring.types';

/* ------------------------------------------------------------------ */
/* Without a database: control flow and conversion of raw values       */
/* ------------------------------------------------------------------ */

describe('MonitoringService (without database)', () => {
  /** A QueryBuilder that accepts any chain and resolves to `raw`. */
  function builder(raw: Record<string, unknown> | undefined) {
    const qb: Record<string, jest.Mock> = {};
    for (const name of [
      'select',
      'addSelect',
      'where',
      'andWhere',
      'setParameters',
      'leftJoinAndSelect',
      'orderBy',
      'take',
    ]) {
      qb[name] = jest.fn(() => qb);
    }
    qb.getRawOne = jest.fn(() => Promise.resolve(raw));
    qb.getMany = jest.fn(() => Promise.resolve([]));
    return qb;
  }

  function setup(rawValues: Map<unknown, Record<string, unknown> | undefined>) {
    const queries: string[] = [];
    const manager = {
      query: jest.fn((sql: string) => {
        queries.push(sql);
        return Promise.resolve([]);
      }),
      find: jest.fn(() => Promise.resolve([])),
      createQueryBuilder: jest.fn((entity: unknown) =>
        builder(rawValues.get(entity)),
      ),
    };
    const dataSource = {
      transaction: jest.fn((work: (m: EntityManager) => Promise<unknown>) =>
        work(manager as unknown as EntityManager),
      ),
    };
    const service = new MonitoringService(dataSource as unknown as DataSource);
    return { service, dataSource, manager, queries };
  }

  it('collects everything in exactly one read-only transaction', async () => {
    const { service, dataSource, manager, queries } = setup(new Map());
    await service.kennzahlen();

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(queries[0]).toBe(
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
    );
    // 8 aggregate queries + activations + 3 lists = 12 instead of 29 before.
    expect(manager.createQueryBuilder).toHaveBeenCalledTimes(9);
    expect(manager.find).toHaveBeenCalledTimes(3);
  });

  it('converts Postgres text (bigint/numeric) to numbers and missing values to 0', async () => {
    const { service } = setup(
      new Map<unknown, Record<string, unknown> | undefined>([
        [Organization, { total: '12', recent: '3' }],
        [User, { total: '40', active: '38', recent: '0' }],
        [
          Event,
          {
            total: '9',
            active: '2',
            test: '1',
            paid: '4',
            pending: '1',
            invoice: '2',
            waived: '1',
            revenue_total: '150.50',
            revenue_today: '0',
            revenue_month: '25.00',
          },
        ],
        [RentalAssignment, { revenue_total: '99.90' }],
        [ContactRequest, undefined],
        [SupportMessage, { unread: '0', threads: '0', latest: null }],
        [Device, { total: '5', verified: '4' }],
        [Order, { total: '1000', recent: '17' }],
      ]),
    );

    const k = await service.kennzahlen();

    expect(k.organisationen).toEqual({ gesamt: 12, neuImMonat: 3, letzte: [] });
    expect(k.nutzer).toEqual({
      gesamt: 40,
      aktiv: 38,
      neuImMonat: 0,
      letzte: [],
    });
    expect(k.veranstaltungen).toEqual({
      gesamt: 9,
      aktiv: 2,
      imTest: 1,
      bezahlt: 4,
      pending: 1,
      aufRechnung: 2,
      erlassen: 1,
      letzteFreischaltungen: [],
    });
    expect(k.umsatz).toEqual({
      bezahlteVeranstaltungen: 6,
      summeEur: 150.5,
      heuteEur: 0,
      monatEur: 25,
      mieteEur: 99.9,
    });
    expect(k.kontaktanfragen).toEqual({ offen: 0, neu24h: 0, letzte: [] });
    expect(k.support).toEqual({
      ungelesen: 0,
      threadsMitUngelesen: 0,
      letzteNachrichtAm: null,
    });
    expect(k.geraete).toEqual({ gesamt: 5, freigegeben: 4 });
    expect(k.bestellungen).toEqual({ gesamt: 1000, letzte24h: 17 });
  });
});

/* ------------------------------------------------------------------ */
/* With a database: old and new implementation return the same bytes  */
/* ------------------------------------------------------------------ */

/**
 * Only runs when a throwaway database is given, e.g.
 *
 *   MONITORING_TEST_DATABASE_URL=postgres://openeos@127.0.0.1:5432/openeos_test pnpm test
 *
 * The test creates the schema via migrations and TRUNCATES the tables
 * involved. That is why the database name must end in `_test`.
 */
const TEST_DB = process.env.MONITORING_TEST_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

describeWithDb(
  'MonitoringService against Postgres: response identical to before the refactor',
  () => {
    let ds: DataSource;

    beforeAll(async () => {
      const name = new URL(TEST_DB!).pathname.replace(/^\//, '');
      if (!name.endsWith('_test')) {
        throw new Error(
          `Database "${name}" does not end in _test — aborting, the test truncates tables.`,
        );
      }
      ds = new DataSource({
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
      await ds?.destroy();
    });

    async function truncate(): Promise<void> {
      await ds.query(`TRUNCATE rental_assignments, rental_hardware, support_messages,
      contact_requests, orders, devices, events, user_organizations, users,
      organizations CASCADE`);
    }

    function withoutTimestamp(k: Kennzahlen): string {
      return JSON.stringify({ ...k, erhobenAm: '<time>' });
    }

    async function compare(): Promise<{
      before: Kennzahlen;
      after: Kennzahlen;
    }> {
      const before = await metricsBeforeRefactor(ds);
      const after = await new MonitoringService(ds).kennzahlen();
      expect(withoutTimestamp(after)).toBe(withoutTimestamp(before));
      return { before, after };
    }

    it('empty database', async () => {
      await truncate();
      const { after } = await compare();
      expect(after.support.letzteNachrichtAm).toBeNull();
      expect(after.umsatz.summeEur).toBe(0);
      expect(after.umsatz.mieteEur).toBe(0);
    });

    it('mixed data with edge cases', async () => {
      await truncate();
      await seed(ds);
      const { after } = await compare();

      /* The fixtures are built so these values are fixed — so the
       comparison cannot pass two implementations that are equally wrong. */
      expect(after.organisationen.gesamt).toBe(13);
      expect(after.organisationen.neuImMonat).toBe(7);
      expect(after.organisationen.letzte).toHaveLength(LISTEN_LAENGE);
      expect(after.nutzer).toMatchObject({
        gesamt: 13,
        aktiv: 11,
        neuImMonat: 7,
      });
      expect(after.veranstaltungen).toMatchObject({
        gesamt: 11,
        aktiv: 3,
        imTest: 2,
        bezahlt: 4,
        pending: 1,
        aufRechnung: 2,
        erlassen: 1,
      });
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const monthStart = new Date(dayStart);
      monthStart.setDate(1);
      /* On the 1st and 2nd of a month the mid-month point can fall on
       today; then the second event (40 €) also counts as "today". */
      const midMonth =
        monthStart.getTime() + (Date.now() - monthStart.getTime()) / 2;
      const expectedToday = 25 + (midMonth - 20 >= dayStart.getTime() ? 40 : 0);
      expect(after.umsatz).toEqual({
        bezahlteVeranstaltungen: 6,
        summeEur: 145.5,
        heuteEur: expectedToday,
        monatEur: 65,
        mieteEur: 135.5,
      });
      expect(after.kontaktanfragen).toMatchObject({ offen: 8, neu24h: 5 });
      expect(after.kontaktanfragen.letzte[0].vorschau).toHaveLength(
        VORSCHAU_LAENGE + 1,
      );
      expect(after.support).toMatchObject({
        ungelesen: 3,
        threadsMitUngelesen: 2,
      });
      expect(after.support.letzteNachrichtAm).not.toBeNull();
      expect(after.geraete).toEqual({ gesamt: 3, freigegeben: 2 });
      expect(after.bestellungen).toEqual({ gesamt: 5, letzte24h: 3 });
    });
  },
);

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

async function seed(ds: DataSource): Promise<void> {
  const now = Date.now();
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  /* Timestamps that are safely inside or outside the windows regardless
     of the time of day the test runs. The offset `i` keeps the order
     unambiguous. */
  const thisMonth = (i: number) =>
    new Date(monthStart.getTime() + (now - monthStart.getTime()) / 2 - i * 10);
  const today = (i: number) =>
    new Date(dayStart.getTime() + (now - dayStart.getTime()) / 2 - i * 10);
  const beforeThisMonth = (i: number) =>
    new Date(monthStart.getTime() - (i + 1) * 86_400_000);
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000);

  // Organizations: 14 created, one of them deleted → 13; 7 new this month.
  const orgs: string[] = [];
  for (let i = 0; i < 14; i++) {
    const id = randomUUID();
    orgs.push(id);
    const createdAt = i < 8 ? thisMonth(i) : beforeThisMonth(i);
    await ds.query(
      `INSERT INTO organizations (id, name, slug, support_pin, created_at, billing_mode, deleted_at)
       VALUES ($1, $2, $3, '123456', $4, $5, $6)`,
      [
        id,
        `Club ${i}`,
        `club-${i}`,
        createdAt,
        i % 3 === 0 ? 'invoice' : 'prepaid',
        i === 0 ? thisMonth(0) : null,
      ],
    );
  }

  // Users: 14 created, one deleted → 13; 2 inactive; 7 new this month.
  for (let i = 0; i < 14; i++) {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO users (id, email, first_name, last_name, is_active, email_verified_at, created_at, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        `u${i}@example.test`,
        `First${i}`,
        i === 3 ? '' : `Last${i}`,
        i !== 4 && i !== 9,
        i % 2 ? thisMonth(i) : null,
        i < 8 ? thisMonth(i + 20) : beforeThisMonth(i),
        i === 1 ? thisMonth(1) : null,
      ],
    );
    if (i % 4 !== 2) {
      await ds.query(
        `INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1, $2, 'admin')`,
        [id, orgs[(i + 1) % orgs.length]],
      );
    }
  }

  // Events: [status, billing, paidAt, price, deleted]
  const events: [string, string, Date | null, string | null, boolean][] = [
    ['active', 'paid', today(1), '25.00', false], // today + month
    ['active', 'paid', thisMonth(2), '40.00', false], // month
    ['inactive', 'paid', beforeThisMonth(1), '20.50', false],
    ['test', 'paid', null, null, false], // paid without price/date
    ['active', 'invoice', beforeThisMonth(3), '60.00', false],
    ['inactive', 'invoice', null, null, false],
    ['test', 'pending', null, null, false],
    ['inactive', 'waived', thisMonth(5), '0.00', false],
    ['inactive', 'none', null, null, false],
    ['draft', 'none', null, null, false],
    ['completed', 'none', null, null, false],
    ['active', 'paid', today(2), '999.00', true], // deleted: counts nowhere
  ];
  for (const [
    i,
    [status, billing, paidAt, price, deleted],
  ] of events.entries()) {
    await ds.query(
      `INSERT INTO events (organization_id, name, status, billing_status, paid_at, price_charged, created_at, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        // One organization each: at most one active/test event per
        // organization (index events_one_active_per_org).
        orgs[i + 1],
        `Festival ${i}`,
        status,
        billing,
        paidAt,
        price,
        thisMonth(i),
        deleted ? thisMonth(0) : null,
      ],
    );
  }

  // Devices: 3, 2 of them verified.
  for (const [i, status] of ['verified', 'verified', 'pending'].entries()) {
    await ds.query(
      `INSERT INTO devices (name, type, device_token, status) VALUES ($1, 'pos', $2, $3)`,
      [`Till ${i}`, `tok-${randomUUID()}`, status],
    );
  }

  // Orders: 5, 3 of them in the last 24 h.
  for (const [i, h] of [1, 2, 23, 25, 48].entries()) {
    await ds.query(
      `INSERT INTO orders (organization_id, order_number, daily_number, created_at) VALUES ($1, $2, $3, $4)`,
      [orgs[1], `B-${i}`, i + 1, hoursAgo(h)],
    );
  }

  // Contact requests: 12; 8 open; 5 in the last 24 h; one long message.
  for (let i = 0; i < 12; i++) {
    await ds.query(
      `INSERT INTO contact_requests (type, name, email, organization, message, handled_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        i % 2 ? 'demo' : 'contact',
        `Request ${i}`,
        `c${i}@example.test`,
        i % 3 ? `Company ${i}` : null,
        i === 0 ? 'x'.repeat(VORSCHAU_LAENGE + 40) : `Short ${i}`,
        i % 3 === 2 ? hoursAgo(1) : null,
        hoursAgo(i < 5 ? i + 0.5 : 30 + i),
      ],
    );
  }

  // Support: inbound unread (2 orgs, 3 messages), read, outbound.
  // The newest inbound one has microseconds — checks rounding to ms.
  const support: [string, string, boolean, string][] = [
    [orgs[1], 'inbound', false, "now() - interval '3 hours'"],
    [orgs[1], 'inbound', false, "now() - interval '2 hours'"],
    [
      orgs[2],
      'inbound',
      false,
      "now() - interval '90 minutes' + interval '123 microseconds'",
    ],
    [orgs[3], 'inbound', true, "now() - interval '5 hours'"],
    [orgs[4], 'outbound', false, "now() - interval '1 minute'"],
  ];
  for (const [org, direction, read, time] of support) {
    await ds.query(
      `INSERT INTO support_messages (organization_id, direction, body, read_by_admin_at, created_at)
       VALUES ($1, $2, 'Hello', ${read ? 'now()' : 'NULL'}, ${time})`,
      [org, direction],
    );
  }

  // Rentals: confirmed/active/returned count → 50 + 35.50 + 50 = 135.50.
  const [user] = await ds.query<{ id: string }[]>(
    `SELECT id FROM users LIMIT 1`,
  );
  const hw = randomUUID();
  await ds.query(
    `INSERT INTO rental_hardware (id, type, name, serial_number, daily_rate)
     VALUES ($1, 'printer', 'Printer', 'SN-1', 10)`,
    [hw],
  );
  const rentals: [string, string][] = [
    ['confirmed', '50.00'],
    ['active', '35.50'],
    ['returned', '50.00'],
    ['pending', '70.00'],
    ['cancelled', '80.00'],
  ];
  for (const [status, amount] of rentals) {
    await ds.query(
      `INSERT INTO rental_assignments (rental_hardware_id, organization_id, status, start_date,
         end_date, daily_rate, total_days, total_amount, assigned_by_user_id)
       VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_DATE, 10, 1, $4, $5)`,
      [hw, orgs[1], status, amount, user.id],
    );
  }
}

/* ------------------------------------------------------------------ */
/* Reference: the implementation before the refactor, kept as-is       */
/* ------------------------------------------------------------------ */

/**
 * State before the refactor (29 queries via `Promise.all`), only switched
 * from repository injection to `ds.getRepository`. Used solely for the
 * comparison; it takes the mappers (`to…`) from the service because those
 * did not change.
 */
async function metricsBeforeRefactor(ds: DataSource): Promise<Kennzahlen> {
  const organizations = ds.getRepository(Organization);
  const users = ds.getRepository(User);
  const events = ds.getRepository(Event);
  const devices = ds.getRepository(Device);
  const orders = ds.getRepository(Order);
  const contactRequests = ds.getRepository(ContactRequest);
  const supportMessages = ds.getRepository(SupportMessage);
  const rentals = ds.getRepository(RentalAssignment);
  const PAID_OR_INVOICED = ['paid', 'invoice'];
  /* The mappers are private methods of the service; for the comparison
     they are pulled out with their signature, not re-implemented. */
  const map = new MonitoringService(ds) as unknown as {
    toOrganization(o: Organization): NeueOrganisation;
    toUser(u: User): NeuerNutzer;
    toActivation(e: Event): Freischaltung;
    toContactRequest(a: ContactRequest): Kontaktanfrage;
  };

  const revenue = async (status: string[], since?: Date): Promise<number> => {
    const query = events
      .createQueryBuilder('e')
      .select('COALESCE(SUM(e.priceCharged), 0)', 'total')
      .where('e.billingStatus IN (:...s)', { s: status });
    if (since) query.andWhere('e.paidAt >= :since', { since });
    const row = await query.getRawOne<{ total: string }>();
    return Number(row?.total ?? 0);
  };

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    orgTotal,
    orgRecent,
    orgLatest,
    userTotal,
    userActive,
    userRecent,
    userLatest,
    eventTotal,
    eventActive,
    eventTest,
    eventPaid,
    eventPending,
    eventInvoiced,
    eventWaived,
    activations,
    revenueTotal,
    revenueToday,
    revenueMonth,
    rentalTotal,
    contactsOpen,
    contactsRecent,
    contactsLatest,
    supportUnread,
    supportThreads,
    supportLatest,
    deviceTotal,
    deviceVerified,
    orderTotal,
    orders24h,
  ] = await Promise.all([
    organizations.count(),
    organizations
      .createQueryBuilder('o')
      .where('o.createdAt >= :m', { m: monthStart })
      .getCount(),
    organizations.find({ order: { createdAt: 'DESC' }, take: LISTEN_LAENGE }),

    users.count(),
    users.count({ where: { isActive: true } }),
    users
      .createQueryBuilder('u')
      .where('u.createdAt >= :m', { m: monthStart })
      .getCount(),
    users.find({
      order: { createdAt: 'DESC' },
      take: LISTEN_LAENGE,
      relations: ['userOrganizations', 'userOrganizations.organization'],
    }),

    events.count(),
    events.count({ where: { status: 'active' as never } }),
    events.count({ where: { status: 'test' as never } }),
    events.count({ where: { billingStatus: 'paid' as never } }),
    events.count({ where: { billingStatus: 'pending' as never } }),
    events.count({ where: { billingStatus: 'invoice' as never } }),
    events.count({ where: { billingStatus: 'waived' as never } }),

    events
      .createQueryBuilder('e')
      .leftJoinAndSelect('e.organization', 'org')
      .where('e.billingStatus IN (:...s)', { s: PAID_OR_INVOICED })
      .orderBy('e.paidAt', 'DESC', 'NULLS LAST')
      .take(LISTEN_LAENGE)
      .getMany(),

    revenue(PAID_OR_INVOICED),
    revenue(PAID_OR_INVOICED, dayStart),
    revenue(PAID_OR_INVOICED, monthStart),
    rentals
      .createQueryBuilder('r')
      .select('COALESCE(SUM(r.totalAmount), 0)', 'total')
      .where("r.status IN ('confirmed','active','returned')")
      .getRawOne<{ total: string }>(),

    contactRequests.count({ where: { handledAt: IsNull() } }),
    contactRequests
      .createQueryBuilder('c')
      .where('c.createdAt >= :g', { g: since24h })
      .getCount(),
    contactRequests.find({ order: { createdAt: 'DESC' }, take: LISTEN_LAENGE }),

    supportMessages.count({
      where: { direction: 'inbound', readByAdminAt: IsNull() },
    }),
    supportMessages
      .createQueryBuilder('m')
      .select('COUNT(DISTINCT m.organizationId)', 'count')
      .where("m.direction = 'inbound' AND m.readByAdminAt IS NULL")
      .getRawOne<{ count: string }>(),
    supportMessages.findOne({
      where: { direction: 'inbound' },
      order: { createdAt: 'DESC' },
    }),

    devices.count(),
    devices.count({ where: { status: 'verified' as never } }),

    orders.count(),
    orders
      .createQueryBuilder('o')
      .where('o.createdAt >= :g', { g: since24h })
      .getCount(),
  ]);

  return {
    erhobenAm: new Date().toISOString(),
    organisationen: {
      gesamt: orgTotal,
      neuImMonat: orgRecent,
      letzte: orgLatest.map((o) => map.toOrganization(o)),
    },
    nutzer: {
      gesamt: userTotal,
      aktiv: userActive,
      neuImMonat: userRecent,
      letzte: userLatest.map((u) => map.toUser(u)),
    },
    veranstaltungen: {
      gesamt: eventTotal,
      aktiv: eventActive,
      imTest: eventTest,
      bezahlt: eventPaid,
      pending: eventPending,
      aufRechnung: eventInvoiced,
      erlassen: eventWaived,
      letzteFreischaltungen: activations.map((e) => map.toActivation(e)),
    },
    umsatz: {
      bezahlteVeranstaltungen: eventPaid + eventInvoiced,
      summeEur: revenueTotal,
      heuteEur: revenueToday,
      monatEur: revenueMonth,
      mieteEur: Number(rentalTotal?.total ?? 0),
    },
    kontaktanfragen: {
      offen: contactsOpen,
      neu24h: contactsRecent,
      letzte: contactsLatest.map((a) => map.toContactRequest(a)),
    },
    support: {
      ungelesen: supportUnread,
      threadsMitUngelesen: Number(supportThreads?.count ?? 0),
      letzteNachrichtAm: supportLatest?.createdAt?.toISOString() ?? null,
    },
    geraete: { gesamt: deviceTotal, freigegeben: deviceVerified },
    bestellungen: { gesamt: orderTotal, letzte24h: orders24h },
  };
}
