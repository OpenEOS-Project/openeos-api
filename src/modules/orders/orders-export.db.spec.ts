import { randomUUID } from 'crypto';
import * as path from 'path';
import { ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  Order,
  Organization,
  User,
  UserOrganization,
} from '../../database/entities';
import { ExportOrdersDto, OrdersExportVariant } from './dto';
import { OrdersExportService } from './orders-export.service';
import { OrdersService } from './orders.service';

/**
 * CSV-Export der Bestellungen gegen ein echtes Postgres: Filter wie die
 * Liste, Rechte, Betriebsart „Nur Bons“, Format (BOM, Semikolon,
 * Dezimalkomma, deutsche Zeit) und Schreiben in Bloecken.
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://openeos:openeos@127.0.0.1:5544/openeos_export_scratch pnpm test
 *
 * Name muss auf `_test` oder `_scratch` enden.
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

describeWithDb('OrdersExportService against Postgres', () => {
  let ds: DataSource;
  let service: OrdersExportService;
  const orgIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    const name = new URL(TEST_DB!).pathname.replace(/^\//, '');
    if (!/_(test|scratch)$/.test(name)) {
      throw new Error(`Database "${name}" does not end in _test/_scratch`);
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
    // applyOrderFilters braucht keine Abhaengigkeiten des Dienstes.
    const ordersService = Object.create(
      OrdersService.prototype,
    ) as OrdersService;
    service = new OrdersExportService(
      ds.getRepository(Order),
      ds.getRepository(UserOrganization),
      ds.getRepository(Organization),
      ordersService,
    );
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

  async function q<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return await ds.query(sql, params);
  }

  async function member(
    orgId: string,
    role: 'admin' | 'member',
    permissions: Record<string, boolean> = {},
  ): Promise<User> {
    const id = randomUUID();
    userIds.push(id);
    await q(
      `INSERT INTO users (id, email, first_name, last_name) VALUES ($1, $2, 'Eva', 'Export')`,
      [id, `export-${id}@example.org`],
    );
    await q(
      `INSERT INTO user_organizations (user_id, organization_id, role, permissions)
       VALUES ($1, $2, $3, $4)`,
      [id, orgId, role, JSON.stringify(permissions)],
    );
    return { id } as User;
  }

  interface World {
    orgId: string;
    eventId: string;
    otherEventId: string;
    deviceId: string;
    stationId: string;
    categoryId: string;
    productId: string;
    admin: User;
  }

  async function world(orderOnly = false): Promise<World> {
    const orgId = randomUUID();
    orgIds.push(orgId);
    await q(
      `INSERT INTO organizations (id, name, slug, support_pin, settings, country, operating_mode)
       VALUES ($1, 'Verein', $2, '123456', '{}', 'AT', $3)`,
      [orgId, `verein-${orgId}`, orderOnly ? 'orders_only' : 'full'],
    );
    const [event] = await q<{ id: string }>(
      `INSERT INTO events (organization_id, name, status)
       VALUES ($1, 'Sommerfest; Zelt', 'active') RETURNING id`,
      [orgId],
    );
    const [other] = await q<{ id: string }>(
      `INSERT INTO events (organization_id, name, status)
       VALUES ($1, 'Probelauf', 'inactive') RETURNING id`,
      [orgId],
    );
    const [device] = await q<{ id: string }>(
      `INSERT INTO devices (organization_id, name, type, device_token, settings)
       VALUES ($1, 'Kasse 1', 'pos', $2, '{}') RETURNING id`,
      [orgId, `tok-${randomUUID()}`],
    );
    const [station] = await q<{ id: string }>(
      `INSERT INTO production_stations (event_id, name) VALUES ($1, 'Grill') RETURNING id`,
      [event.id],
    );
    const [category] = await q<{ id: string }>(
      `INSERT INTO categories (event_id, name) VALUES ($1, 'Essen') RETURNING id`,
      [event.id],
    );
    const [product] = await q<{ id: string }>(
      `INSERT INTO products (event_id, category_id, name, price, tax_rate)
       VALUES ($1, $2, 'Bratwurst', 4.5, 7) RETURNING id`,
      [event.id, category.id],
    );
    return {
      orgId,
      eventId: event.id,
      otherEventId: other.id,
      deviceId: device.id,
      stationId: station.id,
      categoryId: category.id,
      productId: product.id,
      admin: await member(orgId, 'admin'),
    };
  }

  let daily = 0;
  async function order(
    w: World,
    options: {
      eventId?: string;
      createdAt: Date;
      pay?: 'cash' | 'sumup_terminal' | null;
      isTest?: boolean;
      customerName?: string | null;
      notes?: string | null;
      status?: string;
      refunded?: number;
    },
  ): Promise<string> {
    daily += 1;
    const pay = options.pay === undefined ? 'cash' : options.pay;
    const total = 24.5;
    const [o] = await q<{ id: string }>(
      `INSERT INTO orders (organization_id, event_id, order_number, daily_number,
         subtotal, discount_amount, tip_amount, pfand_total, total, paid_amount,
         refunded_amount, tax_total, payment_status, status, created_by_device_id,
         table_number, customer_name, customer_phone, notes, is_test, created_at)
       VALUES ($1, $2, $3, $4, 22.5, 0, 0, 2, $5, $6, $7, 3.59, $8, $9, $10,
               'A03', $11, '0170 1234567', $12, $13, $14)
       RETURNING id`,
      [
        w.orgId,
        options.eventId ?? w.eventId,
        `SF-${String(daily).padStart(4, '0')}`,
        daily,
        total,
        pay ? total : 0,
        options.refunded ?? 0,
        pay ? 'paid' : 'unpaid',
        options.status ?? 'completed',
        w.deviceId,
        options.customerName ?? null,
        options.notes ?? null,
        options.isTest ?? false,
        options.createdAt,
      ],
    );
    await q(
      `INSERT INTO order_items (order_id, product_id, category_id, product_name, category_name,
         quantity, unit_price, options_price, tax_rate, total_price, status, options,
         production_station_id, deposit_amount, deposit_tax_rate, refunded_quantity, notes, sort_order)
       VALUES ($1, $2, $3, 'Bratwurst', 'Essen', 3, 4.5, 0.5, 7, 15, 'delivered',
               $4, $5, 0, NULL, 1, 'ohne Senf', 0),
              ($1, $2, $3, 'Pils "Hell"', 'Getränke', 2, 3.75, 0, 19, 7.5, 'cancelled',
               '{"selected": []}', NULL, 1, 19, 0, NULL, 1)`,
      [
        o.id,
        w.productId,
        w.categoryId,
        JSON.stringify({
          selected: [
            { group: 'Größe', option: 'Groß', priceModifier: 0.5 },
            { group: 'Brot', option: 'mit Brötchen', priceModifier: 0 },
          ],
        }),
        w.stationId,
      ],
    );
    if (pay) {
      await q(
        `INSERT INTO payments (order_id, amount, payment_method, payment_provider, status)
         VALUES ($1, $2, $3, $4, 'captured')`,
        [o.id, total, pay, pay === 'cash' ? 'CASH' : 'SUMUP'],
      );
    }
    return o.id;
  }

  async function csv(
    w: World,
    query: Partial<ExportOrdersDto> = {},
    user: User = w.admin,
  ): Promise<{ text: string; filename: string; chunks: number }> {
    const file = await service.prepare(w.orgId, user, query as ExportOrdersDto);
    let text = '';
    let chunks = 0;
    for await (const chunk of file.chunks) {
      text += chunk;
      chunks += 1;
    }
    return { text, filename: file.filename, chunks };
  }

  const lines = (text: string) =>
    text
      .replace(/^\uFEFF/, '')
      .split('\r\n')
      .filter(Boolean);
  const cells = (line: string) => line.split(';');

  it('one row per order: BOM, German headers, decimal comma, Berlin time, oldest first', async () => {
    const w = await world();
    // 22:30 UTC im Sommer = 00:30 Uhr am naechsten Tag in Berlin.
    await order(w, {
      createdAt: new Date('2026-07-11T22:30:15Z'),
      customerName: '=Anna; "Gast"',
      notes: 'Bitte\nschnell',
    });
    await order(w, {
      createdAt: new Date('2026-07-11T10:00:00Z'),
      pay: 'sumup_terminal',
      refunded: 5,
    });

    const { text, filename } = await csv(w);
    expect(text.startsWith('\uFEFF')).toBe(true);
    expect(filename).toMatch(/^bestellungen_\d{4}-\d{2}-\d{2}\.csv$/);
    expect(text).toContain('\r\n');

    const [header, first, second, ...rest] = lines(text);
    expect(rest).toEqual([]);
    expect(cells(header)).toEqual([
      'Bestellnummer',
      'Tagesnummer',
      'Datum',
      'Uhrzeit',
      'Veranstaltung',
      'Status',
      'Kanal',
      'Ausgabe',
      'Tisch',
      'Gerät',
      'Artikel',
      'Zahlart',
      'Zwischensumme',
      'Rabatt',
      'Pfand',
      'Trinkgeld',
      'Gesamt',
      'Bezahlt',
      'Erstattet',
      'Enthaltene MwSt',
      'Testbestellung',
      'Gastname',
      'Anmerkung',
    ]);

    // Aelteste zuerst: 12:00 Uhr Berlin (SumUp, teilweise erstattet).
    expect(first).toContain(';11.07.2026;12:00:00;"Sommerfest; Zelt";');
    expect(first).toContain(
      ';Teilweise erstattet;Kasse;Abholung;A03;Kasse 1;3;SumUp;',
    );
    expect(first).toContain(
      ';22,50;0,00;2,00;0,00;24,50;24,50;5,00;3,59;Nein;;',
    );

    // 00:30 Uhr am 12.07. in Berlin, nicht 22:30 am 11.07.
    expect(second).toContain(';12.07.2026;00:30:15;');
    expect(second).toContain(';Abgeschlossen;');
    expect(second).toContain(';Bar;');
    // Gastname maskiert und gegen Formeln geschuetzt, Anmerkung mit Umbruch.
    expect(text).toContain(`;"'=Anna; ""Gast""";"Bitte\nschnell"\r\n`);
    // Telefonnummern nie.
    expect(text).not.toContain('0170');
  });

  it('one row per position: product, variant, unit price incl. options, VAT rate, station', async () => {
    const w = await world();
    await order(w, { createdAt: new Date('2026-01-15T11:05:00Z') });

    const { text, filename } = await csv(w, {
      variant: OrdersExportVariant.ITEMS,
    });
    expect(filename).toMatch(/^bestellpositionen_/);
    const [header, wurst, pils, ...rest] = lines(text);
    expect(rest).toEqual([]);
    expect(cells(header)).toEqual([
      'Bestellnummer',
      'Datum',
      'Uhrzeit',
      'Veranstaltung',
      'Tisch',
      'Produkt',
      'Kategorie',
      'Variante',
      'Menge',
      'Erstattete Menge',
      'Einzelpreis',
      'MwSt-Satz (%)',
      'Pfand je Stück',
      'Pfand MwSt-Satz (%)',
      'Positionssumme',
      'Status',
      'Station',
      'Testbestellung',
      'Anmerkung',
    ]);
    // Winterzeit: 11:05 UTC = 12:05 Uhr.
    expect(wurst).toMatch(
      /^SF-\d{4};15\.01\.2026;12:05:00;"Sommerfest; Zelt";A03;Bratwurst;Essen;Groß, mit Brötchen;3;1;5,00;7;0,00;;15,00;Serviert;Grill;Nein;ohne Senf$/,
    );
    expect(pils).toMatch(
      /;"Pils ""Hell""";Getränke;;2;0;3,75;19;1,00;19;7,50;Storniert;;Nein;$/,
    );
  });

  it('applies the list filters: event, date range, status, payment method, test mode', async () => {
    const w = await world();
    const day1 = new Date('2026-08-01T12:00:00Z');
    const day2 = new Date('2026-08-02T12:00:00Z');
    await order(w, { createdAt: day1 });
    await order(w, { createdAt: day2, pay: 'sumup_terminal' });
    await order(w, { createdAt: day2, pay: null, status: 'in_progress' });
    await order(w, {
      createdAt: day2,
      eventId: w.otherEventId,
      isTest: true,
    });
    const count = async (query: Partial<ExportOrdersDto>) =>
      lines((await csv(w, query)).text).length - 1;

    expect(await count({})).toBe(4);
    expect(await count({ eventId: w.eventId })).toBe(3);
    expect(await count({ eventId: w.otherEventId })).toBe(1);
    expect(await count({ dateFrom: '2026-08-02', dateTo: '2026-08-02' })).toBe(
      3,
    );
    expect(await count({ dateTo: '2026-08-01' })).toBe(1);
    expect(await count({ displayStatus: 'unpaid' })).toBe(1);
    expect(await count({ paymentMethod: 'sumup' })).toBe(1);
    expect(await count({ paymentMethod: 'cash' })).toBe(2);
    expect(await count({ isTest: true })).toBe(1);
    expect(await count({ isTest: false })).toBe(3);
    expect(
      await count({
        isTest: false,
        dateFrom: '2026-08-02',
        displayStatus: 'completed',
      }),
    ).toBe(1);

    const testRow = lines((await csv(w, { isTest: true })).text)[1];
    expect(testRow).toContain(';Probelauf;');
    expect(testRow).toContain(';Ja;');
  });

  it('only exports orders of the own organization', async () => {
    const mine = await world();
    const other = await world();
    await order(mine, { createdAt: new Date() });
    await order(other, { createdAt: new Date() });
    await order(other, { createdAt: new Date() });
    expect(lines((await csv(mine)).text)).toHaveLength(2);
    // Fremde Veranstaltung als Filter: leer, nicht die fremden Bestellungen.
    expect(lines((await csv(mine, { eventId: other.eventId })).text)).toEqual([
      expect.stringMatching(/^Bestellnummer;/),
    ]);
  });

  it('orders_only (Nur Bons): quantities only, no amounts and no payment method', async () => {
    const w = await world(true);
    await order(w, { createdAt: new Date('2026-08-01T12:00:00Z'), pay: null });

    const orders = lines((await csv(w)).text);
    expect(cells(orders[0])).toEqual([
      'Bestellnummer',
      'Tagesnummer',
      'Datum',
      'Uhrzeit',
      'Veranstaltung',
      'Status',
      'Kanal',
      'Ausgabe',
      'Tisch',
      'Gerät',
      'Artikel',
      'Testbestellung',
      'Gastname',
      'Anmerkung',
    ]);
    // Kein „Offen – nicht bezahlt“: kassiert wird ausserhalb.
    expect(orders[1]).toContain(';Abgeschlossen;');
    expect(orders[1]).not.toMatch(/\d,\d\d/);

    const items = lines(
      (await csv(w, { variant: OrdersExportVariant.ITEMS })).text,
    );
    expect(cells(items[0])).not.toEqual(
      expect.arrayContaining(['Einzelpreis']),
    );
    expect(cells(items[0])).toEqual([
      'Bestellnummer',
      'Datum',
      'Uhrzeit',
      'Veranstaltung',
      'Tisch',
      'Produkt',
      'Kategorie',
      'Variante',
      'Menge',
      'Erstattete Menge',
      'Status',
      'Station',
      'Testbestellung',
      'Anmerkung',
    ]);
    expect(items[1]).not.toMatch(/\d,\d\d/);
  });

  it('guest data cleared by retention simply stays empty', async () => {
    const w = await world();
    await order(w, { createdAt: new Date(), customerName: 'Max', notes: 'x' });
    await q(
      `UPDATE orders SET customer_name = NULL, customer_phone = NULL, notes = NULL
        WHERE organization_id = $1`,
      [w.orgId],
    );
    const row = lines((await csv(w)).text)[1];
    expect(row.endsWith(';Nein;;')).toBe(true);
  });

  it('permissions: admin and members with „Bestellungen“; others are refused', async () => {
    const w = await world();
    await order(w, { createdAt: new Date() });
    const withOrders = await member(w.orgId, 'member', { orders: true });
    const reportsOnly = await member(w.orgId, 'member', { reports: true });
    const stranger = await member((await world()).orgId, 'admin');

    expect(lines((await csv(w, {}, withOrders)).text)).toHaveLength(2);
    await expect(csv(w, {}, reportsOnly)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(csv(w, {}, reportsOnly)).rejects.toMatchObject({
      response: { reason: 'INSUFFICIENT_PERMISSIONS' },
    });
    await expect(csv(w, {}, stranger)).rejects.toMatchObject({
      response: { reason: 'ORGANIZATION_ACCESS_DENIED' },
    });
  });

  it('writes large exports in blocks of 500 orders', async () => {
    const w = await world();
    const [o] = await q<{ id: string }>(
      `INSERT INTO orders (organization_id, event_id, order_number, daily_number,
         subtotal, total, paid_amount, payment_status, status, created_at)
       SELECT $1, $2, 'B-' || g, g, 1, 1, 1, 'paid', 'completed',
              now() - (g || ' seconds')::interval
         FROM generate_series(1, 1203) g
       RETURNING id`,
      [w.orgId, w.eventId],
    );
    expect(o).toBeDefined();
    const { text, chunks } = await csv(w);
    // Kopfzeile + drei Bloecke (500, 500, 203).
    expect(chunks).toBe(4);
    const rows = lines(text);
    expect(rows).toHaveLength(1204);
    // Aelteste zuerst.
    expect(rows[1].startsWith('B-1203;')).toBe(true);
    expect(rows[1203].startsWith('B-1;')).toBe(true);
  });
});
