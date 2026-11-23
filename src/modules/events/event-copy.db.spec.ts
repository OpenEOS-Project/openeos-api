import { INVALID_WHERE_VALUES_BEHAVIOR } from '../../config/where-values';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { EventCopyService } from './event-copy.service';

/**
 * Uebernahme aus einer anderen Veranstaltung gegen ein echtes Postgres
 * (Spaltentypen, Fremdschluessel, `date`-Spalte der Schichten, Sperre gegen
 * den Doppelklick).
 *
 * Laeuft nur mit einer Wegwerf-Datenbank, z. B.
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://openeos@127.0.0.1:5432/openeos_copy_scratch pnpm test
 *
 * Der Name der Datenbank muss auf `_test` oder `_scratch` enden.
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

describeWithDb('EventCopyService against Postgres', () => {
  let ds: DataSource;
  const orgIds: string[] = [];
  const service = new EventCopyService();

  beforeAll(async () => {
    const name = new URL(TEST_DB!).pathname.replace(/^\//, '');
    if (!/_(test|scratch)$/.test(name)) {
      throw new Error(
        `Database "${name}" does not end in _test/_scratch — aborting.`,
      );
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
      await ds.destroy();
    }
  });

  async function q<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return await ds.query(sql, params);
  }

  async function seed(vatExempt: boolean) {
    const orgId = randomUUID();
    orgIds.push(orgId);
    await q(
      `INSERT INTO organizations (id, name, slug, support_pin, settings)
       VALUES ($1, 'Testverein', $2, '123456', $3)`,
      [
        orgId,
        `testverein-${orgId}`,
        JSON.stringify({
          currency: 'EUR',
          timezone: 'Europe/Berlin',
          locale: 'de-DE',
          vatExempt,
        }),
      ],
    );
    const event = async (name: string) =>
      (
        await q<{ id: string }>(
          `INSERT INTO events (organization_id, name, status, start_date)
           VALUES ($1, $2, 'inactive', '2026-03-14T00:00:00+01:00') RETURNING id`,
          [orgId, name],
        )
      )[0].id;
    const sourceId = await event('Sportlergala');
    const targetId = await event('Sommerfest');
    const [printer] = await q<{ id: string }>(
      `INSERT INTO printers (organization_id, name, type, connection_type)
       VALUES ($1, 'Bon', 'kitchen', 'network') RETURNING id`,
      [orgId],
    );
    const [pfand] = await q<{ id: string }>(
      `INSERT INTO pfand_types (organization_id, name, amount)
       VALUES ($1, 'Becher', 2) RETURNING id`,
      [orgId],
    );
    const station = async (name: string, handoff: string | null) =>
      (
        await q<{ id: string }>(
          `INSERT INTO production_stations (event_id, name, printer_id, handoff_station_id)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [sourceId, name, printer.id, handoff],
        )
      )[0].id;
    const ausgabe = await station('Ausgabe', null);
    const kueche = await station('Küche', ausgabe);
    const [drinks] = await q<{ id: string }>(
      `INSERT INTO categories (event_id, name, production_station_id)
       VALUES ($1, 'Getränke', $2) RETURNING id`,
      [sourceId, kueche],
    );
    const [beer] = await q<{ id: string }>(
      `INSERT INTO categories (event_id, name, parent_id)
       VALUES ($1, 'Bier', $2) RETURNING id`,
      [sourceId, drinks.id],
    );
    const [pils] = await q<{ id: string }>(
      `INSERT INTO products (event_id, category_id, name, price, tax_rate,
         pfand_type_id, production_station_id, is_favorite, icon, options, stock_quantity)
       VALUES ($1, $2, 'Pils', 4, 19, $3, $4, true, 'oe:beer',
         '{"groups":[{"name":"Größe","type":"single","required":true,"options":[{"name":"0,3","priceModifier":0},{"name":"0,5","priceModifier":1}]}]}', 30)
       RETURNING id`,
      [sourceId, beer.id, pfand.id, kueche],
    );
    const [plan] = await q<{ id: string }>(
      `INSERT INTO shift_plans (organization_id, event_id, name, public_slug, status)
       VALUES ($1, $2, 'Helfer Sportlergala', $3, 'published') RETURNING id`,
      [orgId, sourceId, `helfer-${orgId}`],
    );
    const [job] = await q<{ id: string }>(
      `INSERT INTO shift_jobs (shift_plan_id, name) VALUES ($1, 'Theke') RETURNING id`,
      [plan.id],
    );
    await q(
      `INSERT INTO shifts (shift_job_id, date, start_time, end_time)
       VALUES ($1, '2026-03-14', '18:00', '22:00')`,
      [job.id],
    );
    return { orgId, sourceId, targetId, pfand, pils, printer };
  }

  it('copies the catalog with all references and the station chain', async () => {
    const s = await seed(false);
    const result = await ds.transaction((manager) =>
      service.copyCatalog(manager, {
        organizationId: s.orgId,
        sourceEventId: s.sourceId,
        targetEventId: s.targetId,
      }),
    );
    expect(result).toMatchObject({
      stationsCopied: 2,
      categoriesCopied: 2,
      productsCopied: 1,
    });
    const [product] = await q<Record<string, unknown>>(
      `SELECT p.*, c.name AS category, parent.name AS parent,
              s.name AS station, next.name AS next_station, s.printer_id AS printer
         FROM products p
         JOIN categories c ON c.id = p.category_id
         JOIN categories parent ON parent.id = c.parent_id
         JOIN production_stations s ON s.id = p.production_station_id
         LEFT JOIN production_stations next ON next.id = s.handoff_station_id
        WHERE p.event_id = $1`,
      [s.targetId],
    );
    expect(product).toMatchObject({
      name: 'Pils',
      category: 'Bier',
      parent: 'Getränke',
      station: 'Küche',
      next_station: 'Ausgabe',
      printer: s.printer.id,
      pfand_type_id: s.pfand.id,
      tax_rate: '19.00',
      is_favorite: true,
      icon: 'oe:beer',
      stock_quantity: 0,
    });
    expect(
      (product.options as { groups: unknown[] }).groups.length,
    ).toBeGreaterThan(0);
  });

  it('sets tax 0 for a VAT-exempt organization and shifts shift dates', async () => {
    const s = await seed(true);
    await ds.transaction(async (manager) => {
      await service.copyCatalog(manager, {
        organizationId: s.orgId,
        sourceEventId: s.sourceId,
        targetEventId: s.targetId,
      });
      await service.copyEventShiftPlans(
        manager,
        s.orgId,
        { id: s.sourceId, name: 'Sportlergala' },
        { id: s.targetId, name: 'Sommerfest' },
        118,
      );
    });
    const [product] = await q<{ tax_rate: string }>(
      `SELECT tax_rate FROM products WHERE event_id = $1`,
      [s.targetId],
    );
    expect(product.tax_rate).toBe('0.00');
    const shifts = await q<{ date: string; name: string; status: string }>(
      `SELECT to_char(sh.date, 'YYYY-MM-DD') AS date, sp.name, sp.status
         FROM shifts sh
         JOIN shift_jobs j ON j.id = sh.shift_job_id
         JOIN shift_plans sp ON sp.id = j.shift_plan_id
        WHERE sp.event_id = $1`,
      [s.targetId],
    );
    expect(shifts).toEqual([
      { date: '2026-07-10', name: 'Helfer Sommerfest', status: 'draft' },
    ]);
  });

  it('two concurrent copies into the same event do not duplicate', async () => {
    const s = await seed(false);
    const copy = () =>
      ds.transaction(async (manager) => {
        await manager.query(`SELECT id FROM events WHERE id = $1 FOR UPDATE`, [
          s.targetId,
        ]);
        return service.copyCatalog(manager, {
          organizationId: s.orgId,
          sourceEventId: s.sourceId,
          targetEventId: s.targetId,
        });
      });
    const results = await Promise.all([copy(), copy()]);
    expect(results.map((r) => r.productsCopied).sort()).toEqual([0, 1]);
    const [{ count }] = await q<{ count: string }>(
      `SELECT count(*) FROM products WHERE event_id = $1`,
      [s.targetId],
    );
    expect(count).toBe('1');
    const [{ categories }] = await q<{ categories: string }>(
      `SELECT count(*) AS categories FROM categories WHERE event_id = $1`,
      [s.targetId],
    );
    expect(categories).toBe('2');
  });

  it('rolls back completely when something fails', async () => {
    const s = await seed(false);
    await expect(
      ds.transaction(async (manager) => {
        await service.copyCatalog(manager, {
          organizationId: s.orgId,
          sourceEventId: s.sourceId,
          targetEventId: s.targetId,
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const [{ count }] = await q<{ count: string }>(
      `SELECT (SELECT count(*) FROM products WHERE event_id = $1)
            + (SELECT count(*) FROM categories WHERE event_id = $1)
            + (SELECT count(*) FROM production_stations WHERE event_id = $1) AS count`,
      [s.targetId],
    );
    expect(count).toBe('0');
  });
});
