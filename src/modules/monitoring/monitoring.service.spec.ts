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
/* Ohne Datenbank: Ablauf und Umwandlung der Rohwerte                  */
/* ------------------------------------------------------------------ */

describe('MonitoringService (ohne Datenbank)', () => {
  /** Ein QueryBuilder, der jede Kette mitmacht und `roh` zurückgibt. */
  function builder(roh: Record<string, unknown> | undefined) {
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
    qb.getRawOne = jest.fn(() => Promise.resolve(roh));
    qb.getMany = jest.fn(() => Promise.resolve([]));
    return qb;
  }

  function aufbauen(
    rohwerte: Map<unknown, Record<string, unknown> | undefined>,
  ) {
    const abfragen: string[] = [];
    const manager = {
      query: jest.fn((sql: string) => {
        abfragen.push(sql);
        return Promise.resolve([]);
      }),
      find: jest.fn(() => Promise.resolve([])),
      createQueryBuilder: jest.fn((entity: unknown) =>
        builder(rohwerte.get(entity)),
      ),
    };
    const dataSource = {
      transaction: jest.fn((arbeit: (m: EntityManager) => Promise<unknown>) =>
        arbeit(manager as unknown as EntityManager),
      ),
    };
    const service = new MonitoringService(dataSource as unknown as DataSource);
    return { service, dataSource, manager, abfragen };
  }

  it('erhebt alles in genau einer lesenden Transaktion', async () => {
    const { service, dataSource, manager, abfragen } = aufbauen(new Map());
    await service.kennzahlen();

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(abfragen[0]).toBe(
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
    );
    // 8 Aggregat-Abfragen + Freischaltungen + 3 Listen = 12 statt vorher 29.
    expect(manager.createQueryBuilder).toHaveBeenCalledTimes(9);
    expect(manager.find).toHaveBeenCalledTimes(3);
  });

  it('wandelt Postgres-Text (bigint/numeric) in Zahlen und fehlende Werte in 0', async () => {
    const { service } = aufbauen(
      new Map<unknown, Record<string, unknown> | undefined>([
        [Organization, { gesamt: '12', neu: '3' }],
        [User, { gesamt: '40', aktiv: '38', neu: '0' }],
        [
          Event,
          {
            gesamt: '9',
            aktiv: '2',
            test: '1',
            bezahlt: '4',
            pending: '1',
            rechnung: '2',
            erlassen: '1',
            summe: '150.50',
            heute: '0',
            monat: '25.00',
          },
        ],
        [RentalAssignment, { summe: '99.90' }],
        [ContactRequest, undefined],
        [SupportMessage, { ungelesen: '0', threads: '0', letzte: null }],
        [Device, { gesamt: '5', frei: '4' }],
        [Order, { gesamt: '1000', neu: '17' }],
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
/* Mit Datenbank: alte und neue Umsetzung liefern dieselben Bytes      */
/* ------------------------------------------------------------------ */

/**
 * Läuft nur, wenn eine Wegwerf-Datenbank angegeben ist, z. B.
 *
 *   MONITORING_TEST_DATABASE_URL=postgres://openeos@127.0.0.1:5432/openeos_test pnpm test
 *
 * Der Test legt das Schema per Migration an und LEERT die beteiligten
 * Tabellen. Deshalb muss der Datenbankname auf `_test` enden.
 */
const TEST_DB = process.env.MONITORING_TEST_DATABASE_URL;
const mitDatenbank = TEST_DB ? describe : describe.skip;

mitDatenbank(
  'MonitoringService gegen Postgres: Antwort wie vor dem Umbau',
  () => {
    let ds: DataSource;

    beforeAll(async () => {
      const name = new URL(TEST_DB!).pathname.replace(/^\//, '');
      if (!name.endsWith('_test')) {
        throw new Error(
          `Datenbank "${name}" endet nicht auf _test — Abbruch, der Test leert Tabellen.`,
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

    async function leeren(): Promise<void> {
      await ds.query(`TRUNCATE rental_assignments, rental_hardware, support_messages,
      contact_requests, orders, devices, events, user_organizations, users,
      organizations CASCADE`);
    }

    function ohneZeitstempel(k: Kennzahlen): string {
      return JSON.stringify({ ...k, erhobenAm: '<zeit>' });
    }

    async function vergleichen(): Promise<{
      alt: Kennzahlen;
      neu: Kennzahlen;
    }> {
      const alt = await kennzahlenVorDemUmbau(ds);
      const neu = await new MonitoringService(ds).kennzahlen();
      expect(ohneZeitstempel(neu)).toBe(ohneZeitstempel(alt));
      return { alt, neu };
    }

    it('leere Datenbank', async () => {
      await leeren();
      const { neu } = await vergleichen();
      expect(neu.support.letzteNachrichtAm).toBeNull();
      expect(neu.umsatz.summeEur).toBe(0);
      expect(neu.umsatz.mieteEur).toBe(0);
    });

    it('gemischte Daten mit Randfällen', async () => {
      await leeren();
      await befuellen(ds);
      const { neu } = await vergleichen();

      /* Die Testdaten sind so gebaut, dass diese Werte feststehen — damit
       der Vergleich nicht zwei gleich falsche Umsetzungen durchlässt. */
      expect(neu.organisationen.gesamt).toBe(13);
      expect(neu.organisationen.neuImMonat).toBe(7);
      expect(neu.organisationen.letzte).toHaveLength(LISTEN_LAENGE);
      expect(neu.nutzer).toMatchObject({
        gesamt: 13,
        aktiv: 11,
        neuImMonat: 7,
      });
      expect(neu.veranstaltungen).toMatchObject({
        gesamt: 11,
        aktiv: 3,
        imTest: 2,
        bezahlt: 4,
        pending: 1,
        aufRechnung: 2,
        erlassen: 1,
      });
      const tagesbeginn = new Date();
      tagesbeginn.setHours(0, 0, 0, 0);
      const monatsbeginn = new Date(tagesbeginn);
      monatsbeginn.setDate(1);
      /* Am 1. und 2. eines Monats kann die Monatsmitte heute sein; dann
       zählt die zweite Veranstaltung (40 €) auch zu „heute“. */
      const mitte =
        monatsbeginn.getTime() + (Date.now() - monatsbeginn.getTime()) / 2;
      const heuteErwartet = 25 + (mitte - 20 >= tagesbeginn.getTime() ? 40 : 0);
      expect(neu.umsatz).toEqual({
        bezahlteVeranstaltungen: 6,
        summeEur: 145.5,
        heuteEur: heuteErwartet,
        monatEur: 65,
        mieteEur: 135.5,
      });
      expect(neu.kontaktanfragen).toMatchObject({ offen: 8, neu24h: 5 });
      expect(neu.kontaktanfragen.letzte[0].vorschau).toHaveLength(
        VORSCHAU_LAENGE + 1,
      );
      expect(neu.support).toMatchObject({
        ungelesen: 3,
        threadsMitUngelesen: 2,
      });
      expect(neu.support.letzteNachrichtAm).not.toBeNull();
      expect(neu.geraete).toEqual({ gesamt: 3, freigegeben: 2 });
      expect(neu.bestellungen).toEqual({ gesamt: 5, letzte24h: 3 });
    });
  },
);

/* ------------------------------------------------------------------ */
/* Testdaten                                                           */
/* ------------------------------------------------------------------ */

async function befuellen(ds: DataSource): Promise<void> {
  const jetzt = Date.now();
  const monatsbeginn = new Date();
  monatsbeginn.setDate(1);
  monatsbeginn.setHours(0, 0, 0, 0);
  const tagesbeginn = new Date();
  tagesbeginn.setHours(0, 0, 0, 0);

  /* Zeitpunkte, die unabhängig von der Uhrzeit des Testlaufs sicher
     innerhalb bzw. außerhalb der Fenster liegen. Der Versatz `i` hält
     die Reihenfolge eindeutig. */
  const imMonat = (i: number) =>
    new Date(
      monatsbeginn.getTime() + (jetzt - monatsbeginn.getTime()) / 2 - i * 10,
    );
  const heute = (i: number) =>
    new Date(
      tagesbeginn.getTime() + (jetzt - tagesbeginn.getTime()) / 2 - i * 10,
    );
  const vorMonat = (i: number) =>
    new Date(monatsbeginn.getTime() - (i + 1) * 86_400_000);
  const vorStunden = (h: number) => new Date(jetzt - h * 3_600_000);

  // Organisationen: 14 angelegt, eine davon gelöscht → 13; 7 neu im Monat.
  const orgs: string[] = [];
  for (let i = 0; i < 14; i++) {
    const id = randomUUID();
    orgs.push(id);
    const erstellt = i < 8 ? imMonat(i) : vorMonat(i);
    await ds.query(
      `INSERT INTO organizations (id, name, slug, support_pin, created_at, billing_mode, deleted_at)
       VALUES ($1, $2, $3, '123456', $4, $5, $6)`,
      [
        id,
        `Verein ${i}`,
        `verein-${i}`,
        erstellt,
        i % 3 === 0 ? 'invoice' : 'prepaid',
        i === 0 ? imMonat(0) : null,
      ],
    );
  }

  // Nutzer: 14 angelegt, einer gelöscht → 13; 2 inaktiv; 7 neu im Monat.
  for (let i = 0; i < 14; i++) {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO users (id, email, first_name, last_name, is_active, email_verified_at, created_at, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        `n${i}@beispiel.test`,
        `Vorname${i}`,
        i === 3 ? '' : `Nachname${i}`,
        i !== 4 && i !== 9,
        i % 2 ? imMonat(i) : null,
        i < 8 ? imMonat(i + 20) : vorMonat(i),
        i === 1 ? imMonat(1) : null,
      ],
    );
    if (i % 4 !== 2) {
      await ds.query(
        `INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1, $2, 'admin')`,
        [id, orgs[(i + 1) % orgs.length]],
      );
    }
  }

  // Veranstaltungen: [status, billing, paidAt, preis, gelöscht]
  const events: [string, string, Date | null, string | null, boolean][] = [
    ['active', 'paid', heute(1), '25.00', false], // heute + Monat
    ['active', 'paid', imMonat(2), '40.00', false], // Monat
    ['inactive', 'paid', vorMonat(1), '20.50', false],
    ['test', 'paid', null, null, false], // bezahlt ohne Preis/Datum
    ['active', 'invoice', vorMonat(3), '60.00', false],
    ['inactive', 'invoice', null, null, false],
    ['test', 'pending', null, null, false],
    ['inactive', 'waived', imMonat(5), '0.00', false],
    ['inactive', 'none', null, null, false],
    ['draft', 'none', null, null, false],
    ['completed', 'none', null, null, false],
    ['active', 'paid', heute(2), '999.00', true], // gelöscht: zählt nirgends
  ];
  for (const [
    i,
    [status, billing, paidAt, preis, geloescht],
  ] of events.entries()) {
    await ds.query(
      `INSERT INTO events (organization_id, name, status, billing_status, paid_at, price_charged, created_at, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        // Je eine Organisation: höchstens eine aktive/Test-Veranstaltung je
        // Organisation (Index events_one_active_per_org).
        orgs[i + 1],
        `Fest ${i}`,
        status,
        billing,
        paidAt,
        preis,
        imMonat(i),
        geloescht ? imMonat(0) : null,
      ],
    );
  }

  // Geräte: 3, davon 2 freigegeben.
  for (const [i, status] of ['verified', 'verified', 'pending'].entries()) {
    await ds.query(
      `INSERT INTO devices (name, type, device_token, status) VALUES ($1, 'pos', $2, $3)`,
      [`Kasse ${i}`, `tok-${randomUUID()}`, status],
    );
  }

  // Bestellungen: 5, davon 3 in den letzten 24 h.
  for (const [i, h] of [1, 2, 23, 25, 48].entries()) {
    await ds.query(
      `INSERT INTO orders (organization_id, order_number, daily_number, created_at) VALUES ($1, $2, $3, $4)`,
      [orgs[1], `B-${i}`, i + 1, vorStunden(h)],
    );
  }

  // Kontaktanfragen: 12; 8 offen; 5 in den letzten 24 h; eine lange Nachricht.
  for (let i = 0; i < 12; i++) {
    await ds.query(
      `INSERT INTO contact_requests (type, name, email, organization, message, handled_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        i % 2 ? 'demo' : 'contact',
        `Anfrage ${i}`,
        `k${i}@beispiel.test`,
        i % 3 ? `Firma ${i}` : null,
        i === 0 ? 'x'.repeat(VORSCHAU_LAENGE + 40) : `Kurz ${i}`,
        i % 3 === 2 ? vorStunden(1) : null,
        vorStunden(i < 5 ? i + 0.5 : 30 + i),
      ],
    );
  }

  // Support: eingehend ungelesen (2 Orgs, 3 Nachrichten), gelesen, ausgehend.
  // Die jüngste eingehende hat Mikrosekunden — prüft die Rundung aufs ms.
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
  for (const [org, richtung, gelesen, zeit] of support) {
    await ds.query(
      `INSERT INTO support_messages (organization_id, direction, body, read_by_admin_at, created_at)
       VALUES ($1, $2, 'Hallo', ${gelesen ? 'now()' : 'NULL'}, ${zeit})`,
      [org, richtung],
    );
  }

  // Miete: zählt confirmed/active/returned → 50 + 35.50 + 50 = 135.50.
  const [nutzer] = await ds.query<{ id: string }[]>(
    `SELECT id FROM users LIMIT 1`,
  );
  const hw = randomUUID();
  await ds.query(
    `INSERT INTO rental_hardware (id, type, name, serial_number, daily_rate)
     VALUES ($1, 'printer', 'Drucker', 'SN-1', 10)`,
    [hw],
  );
  const mieten: [string, string][] = [
    ['confirmed', '50.00'],
    ['active', '35.50'],
    ['returned', '50.00'],
    ['pending', '70.00'],
    ['cancelled', '80.00'],
  ];
  for (const [status, betrag] of mieten) {
    await ds.query(
      `INSERT INTO rental_assignments (rental_hardware_id, organization_id, status, start_date,
         end_date, daily_rate, total_days, total_amount, assigned_by_user_id)
       VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_DATE, 10, 1, $4, $5)`,
      [hw, orgs[1], status, betrag, nutzer.id],
    );
  }
}

/* ------------------------------------------------------------------ */
/* Referenz: die Umsetzung vor dem Umbau, unverändert übernommen       */
/* ------------------------------------------------------------------ */

/**
 * Stand vor dem Umbau (29 Abfragen per `Promise.all`), nur von
 * Repository-Injektion auf `ds.getRepository` umgestellt. Dient allein
 * dem Vergleich; die Abbildungen (`als…`) nutzt sie aus dem Service, weil
 * die sich nicht geändert haben.
 */
async function kennzahlenVorDemUmbau(ds: DataSource): Promise<Kennzahlen> {
  const organizations = ds.getRepository(Organization);
  const users = ds.getRepository(User);
  const events = ds.getRepository(Event);
  const devices = ds.getRepository(Device);
  const orders = ds.getRepository(Order);
  const contactRequests = ds.getRepository(ContactRequest);
  const supportMessages = ds.getRepository(SupportMessage);
  const rentals = ds.getRepository(RentalAssignment);
  const BEZAHLT_ODER_RECHNUNG = ['paid', 'invoice'];
  /* Die Abbildungen sind private Methoden des Service; für den Vergleich
     werden sie mit ihrer Signatur hervorgeholt, nicht nachgebaut. */
  const als = new MonitoringService(ds) as unknown as {
    alsOrganisation(o: Organization): NeueOrganisation;
    alsNutzer(u: User): NeuerNutzer;
    alsFreischaltung(e: Event): Freischaltung;
    alsKontaktanfrage(a: ContactRequest): Kontaktanfrage;
  };

  const summe = async (status: string[], ab?: Date): Promise<number> => {
    const abfrage = events
      .createQueryBuilder('e')
      .select('COALESCE(SUM(e.priceCharged), 0)', 'summe')
      .where('e.billingStatus IN (:...s)', { s: status });
    if (ab) abfrage.andWhere('e.paidAt >= :ab', { ab });
    const zeile = await abfrage.getRawOne<{ summe: string }>();
    return Number(zeile?.summe ?? 0);
  };

  const monatsbeginn = new Date();
  monatsbeginn.setDate(1);
  monatsbeginn.setHours(0, 0, 0, 0);
  const tagesbeginn = new Date();
  tagesbeginn.setHours(0, 0, 0, 0);
  const gestern = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    orgGesamt,
    orgNeu,
    orgLetzte,
    nutzerGesamt,
    nutzerAktiv,
    nutzerNeu,
    nutzerLetzte,
    eventGesamt,
    eventAktiv,
    eventTest,
    eventBezahlt,
    eventPending,
    eventRechnung,
    eventErlassen,
    freischaltungen,
    umsatzGesamt,
    umsatzHeute,
    umsatzMonat,
    mieteGesamt,
    anfragenOffen,
    anfragenNeu,
    anfragenLetzte,
    supportUngelesen,
    supportThreads,
    supportLetzte,
    geraeteGesamt,
    geraeteFrei,
    bestellGesamt,
    bestell24h,
  ] = await Promise.all([
    organizations.count(),
    organizations
      .createQueryBuilder('o')
      .where('o.createdAt >= :m', { m: monatsbeginn })
      .getCount(),
    organizations.find({ order: { createdAt: 'DESC' }, take: LISTEN_LAENGE }),

    users.count(),
    users.count({ where: { isActive: true } }),
    users
      .createQueryBuilder('u')
      .where('u.createdAt >= :m', { m: monatsbeginn })
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
      .where('e.billingStatus IN (:...s)', { s: BEZAHLT_ODER_RECHNUNG })
      .orderBy('e.paidAt', 'DESC', 'NULLS LAST')
      .take(LISTEN_LAENGE)
      .getMany(),

    summe(BEZAHLT_ODER_RECHNUNG),
    summe(BEZAHLT_ODER_RECHNUNG, tagesbeginn),
    summe(BEZAHLT_ODER_RECHNUNG, monatsbeginn),
    rentals
      .createQueryBuilder('r')
      .select('COALESCE(SUM(r.totalAmount), 0)', 'summe')
      .where("r.status IN ('confirmed','active','returned')")
      .getRawOne<{ summe: string }>(),

    contactRequests.count({ where: { handledAt: IsNull() } }),
    contactRequests
      .createQueryBuilder('c')
      .where('c.createdAt >= :g', { g: gestern })
      .getCount(),
    contactRequests.find({ order: { createdAt: 'DESC' }, take: LISTEN_LAENGE }),

    supportMessages.count({
      where: { direction: 'inbound', readByAdminAt: IsNull() },
    }),
    supportMessages
      .createQueryBuilder('m')
      .select('COUNT(DISTINCT m.organizationId)', 'anzahl')
      .where("m.direction = 'inbound' AND m.readByAdminAt IS NULL")
      .getRawOne<{ anzahl: string }>(),
    supportMessages.findOne({
      where: { direction: 'inbound' },
      order: { createdAt: 'DESC' },
    }),

    devices.count(),
    devices.count({ where: { status: 'verified' as never } }),

    orders.count(),
    orders
      .createQueryBuilder('o')
      .where('o.createdAt >= :g', { g: gestern })
      .getCount(),
  ]);

  return {
    erhobenAm: new Date().toISOString(),
    organisationen: {
      gesamt: orgGesamt,
      neuImMonat: orgNeu,
      letzte: orgLetzte.map((o) => als.alsOrganisation(o)),
    },
    nutzer: {
      gesamt: nutzerGesamt,
      aktiv: nutzerAktiv,
      neuImMonat: nutzerNeu,
      letzte: nutzerLetzte.map((u) => als.alsNutzer(u)),
    },
    veranstaltungen: {
      gesamt: eventGesamt,
      aktiv: eventAktiv,
      imTest: eventTest,
      bezahlt: eventBezahlt,
      pending: eventPending,
      aufRechnung: eventRechnung,
      erlassen: eventErlassen,
      letzteFreischaltungen: freischaltungen.map((e) =>
        als.alsFreischaltung(e),
      ),
    },
    umsatz: {
      bezahlteVeranstaltungen: eventBezahlt + eventRechnung,
      summeEur: umsatzGesamt,
      heuteEur: umsatzHeute,
      monatEur: umsatzMonat,
      mieteEur: Number(mieteGesamt?.summe ?? 0),
    },
    kontaktanfragen: {
      offen: anfragenOffen,
      neu24h: anfragenNeu,
      letzte: anfragenLetzte.map((a) => als.alsKontaktanfrage(a)),
    },
    support: {
      ungelesen: supportUngelesen,
      threadsMitUngelesen: Number(supportThreads?.anzahl ?? 0),
      letzteNachrichtAm: supportLetzte?.createdAt?.toISOString() ?? null,
    },
    geraete: { gesamt: geraeteGesamt, freigegeben: geraeteFrei },
    bestellungen: { gesamt: bestellGesamt, letzte24h: bestell24h },
  };
}
