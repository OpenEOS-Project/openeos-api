import { randomUUID } from 'crypto';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { AddTestOrderMarker1816000000000 } from '../../database/migrations/1816000000000-AddTestOrderMarker';
import { Order } from '../../database/entities';
import { saveOrderWithNumbers } from '../orders/order-numbering';
import { GatewayService } from '../gateway/gateway.service';
import { TestOrderCleanupService } from './test-order-cleanup.service';

/**
 * Loeschen der Testbuchungen gegen ein echtes Postgres.
 *
 * Laeuft nur mit einer Wegwerf-Datenbank, z. B.
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://openeos@127.0.0.1:5432/openeos_testorders_scratch pnpm test
 *
 * Das Schema entsteht ueber die Migrationen. Die Tests legen eigene
 * Organisationen an und raeumen sie wieder ab; der Name der Datenbank muss
 * trotzdem auf `_test` oder `_scratch` enden.
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

interface Fixture {
  orgId: string;
  eventId: string;
  productId: string;
  untrackedProductId: string;
  testOrderIds: string[];
}

describeWithDb('TestOrderCleanupService against Postgres', () => {
  let ds: DataSource;
  const orgIds: string[] = [];
  const service = new TestOrderCleanupService({} as GatewayService);

  beforeAll(async () => {
    const name = new URL(TEST_DB!).pathname.replace(/^\//, '');
    if (!/_(test|scratch)$/.test(name)) {
      throw new Error(
        `Database "${name}" does not end in _test/_scratch — aborting.`,
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
    if (ds?.isInitialized) {
      if (orgIds.length) {
        // Wegwerf-Datenbank: Aufraeumen ist Kuer, kein Testergebnis.
        await ds.query(
          `DELETE FROM stock_movements WHERE event_id IN
             (SELECT id FROM events WHERE organization_id = ANY($1::uuid[]))`,
          [orgIds],
        );
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

  async function seedOrg(): Promise<string> {
    const id = randomUUID();
    orgIds.push(id);
    await q(
      `INSERT INTO organizations (id, name, slug, support_pin)
       VALUES ($1, 'Testverein', $2, '123456')`,
      [id, `testverein-${id}`],
    );
    return id;
  }

  async function seedEvent(orgId: string, status: string): Promise<string> {
    const [row] = await q<{ id: string }>(
      `INSERT INTO events (organization_id, name, status)
       VALUES ($1, 'Fest', $2) RETURNING id`,
      [orgId, status],
    );
    return row.id;
  }

  async function seedProduct(
    eventId: string,
    stock: number,
    trackInventory = true,
  ): Promise<{ productId: string; categoryId: string }> {
    const [category] = await q<{ id: string }>(
      `INSERT INTO categories (event_id, name) VALUES ($1, 'Getraenke')
       RETURNING id`,
      [eventId],
    );
    const [product] = await q<{ id: string }>(
      `INSERT INTO products (event_id, category_id, name, price,
         track_inventory, stock_quantity)
       VALUES ($1, $2, 'Bier', 3.5, $3, $4) RETURNING id`,
      [eventId, category.id, trackInventory, stock],
    );
    return { productId: product.id, categoryId: category.id };
  }

  /**
   * Bestellung mit einer Position, so wie die Kasse sie anlegt: Bestand
   * wird abgezogen, ohne Journalbuchung.
   */
  async function seedOrder(options: {
    orgId: string;
    eventId: string;
    productId: string;
    quantity: number;
    isTest: boolean;
    dailyNumber: number;
    itemStatus?: string;
    createdAt?: Date;
  }): Promise<{ orderId: string; itemId: string }> {
    const createdAt = options.createdAt ?? new Date();
    const [order] = await q<{ id: string }>(
      `INSERT INTO orders (organization_id, event_id, order_number,
         daily_number, is_test, total, created_at)
       VALUES ($1, $2, $3, $4, $5, 7, $6) RETURNING id`,
      [
        options.orgId,
        options.eventId,
        `20260101-${String(options.dailyNumber).padStart(4, '0')}`,
        options.dailyNumber,
        options.isTest,
        createdAt,
      ],
    );
    const [product] = await q<{ category_id: string; track: boolean }>(
      `SELECT category_id, track_inventory AS track FROM products WHERE id = $1`,
      [options.productId],
    );
    const status = options.itemStatus ?? 'pending';
    const [item] = await q<{ id: string }>(
      `INSERT INTO order_items (order_id, product_id, category_id,
         product_name, category_name, quantity, unit_price, tax_rate,
         total_price, status, created_at)
       VALUES ($1, $2, $3, 'Bier', 'Getraenke', $4, 3.5, 19, 7, $5, $6)
       RETURNING id`,
      [
        order.id,
        options.productId,
        product.category_id,
        options.quantity,
        status,
        createdAt,
      ],
    );
    if (product.track && status !== 'cancelled') {
      await q(
        `UPDATE products SET stock_quantity = stock_quantity - $2 WHERE id = $1`,
        [options.productId, options.quantity],
      );
    }
    const [payment] = await q<{ id: string }>(
      `INSERT INTO payments (order_id, amount, payment_method, payment_provider)
       VALUES ($1, 7, 'cash', 'cash') RETURNING id`,
      [order.id],
    );
    await q(
      `INSERT INTO order_item_payments (order_item_id, payment_id, amount, quantity)
       VALUES ($1, $2, 7, $3)`,
      [item.id, payment.id, options.quantity],
    );
    return { orderId: order.id, itemId: item.id };
  }

  async function seedScenario(): Promise<Fixture> {
    const orgId = await seedOrg();
    const eventId = await seedEvent(orgId, 'test');
    const { productId } = await seedProduct(eventId, 100);
    const { productId: untrackedProductId } = await seedProduct(
      eventId,
      0,
      false,
    );

    const a = await seedOrder({
      orgId,
      eventId,
      productId,
      quantity: 2,
      isTest: true,
      dailyNumber: 1,
    });
    const b = await seedOrder({
      orgId,
      eventId,
      productId,
      quantity: 3,
      isTest: true,
      dailyNumber: 2,
    });
    // Storniert: Bestand wurde schon beim Stornieren zurueckgegeben.
    const c = await seedOrder({
      orgId,
      eventId,
      productId,
      quantity: 5,
      isTest: true,
      dailyNumber: 3,
      itemStatus: 'cancelled',
    });
    const d = await seedOrder({
      orgId,
      eventId,
      productId: untrackedProductId,
      quantity: 4,
      isTest: true,
      dailyNumber: 4,
    });

    const [printer] = await q<{ id: string }>(
      `INSERT INTO printers (organization_id, name, type, connection_type)
       VALUES ($1, 'Bon', 'receipt', 'network') RETURNING id`,
      [orgId],
    );
    await q(
      `INSERT INTO print_jobs (organization_id, printer_id, order_id, payload)
       VALUES ($1, $2, $3, '{"is_test": true}')`,
      [orgId, printer.id, a.orderId],
    );
    await q(
      `INSERT INTO print_jobs (organization_id, printer_id, order_item_id)
       VALUES ($1, $2, $3)`,
      [orgId, printer.id, b.itemId],
    );
    await q(
      `INSERT INTO shop_checkouts (organization_id, event_id, email, items,
         total_amount, order_id)
       VALUES ($1, $2, 'gast@example.com', '[]', 7, $3)`,
      [orgId, eventId, b.orderId],
    );
    await q(
      `INSERT INTO stock_movements (event_id, product_id, type, quantity,
         quantity_before, quantity_after, reference_type, reference_id)
       VALUES ($1, $2, 'sale', -2, 100, 98, 'order', $3)`,
      [eventId, productId, a.orderId],
    );
    await q(
      `INSERT INTO pfand_returns (organization_id, event_id, total_amount, is_test)
       VALUES ($1, $2, 2, true), ($1, $2, 3, false)`,
      [orgId, eventId],
    );

    return {
      orgId,
      eventId,
      productId,
      untrackedProductId,
      testOrderIds: [a.orderId, b.orderId, c.orderId, d.orderId],
    };
  }

  async function count(sql: string, params: unknown[]): Promise<number> {
    const [row] = await q<{ n: string }>(
      `SELECT count(*)::int AS n FROM ${sql}`,
      params,
    );
    return Number(row.n);
  }

  async function stock(productId: string): Promise<number> {
    const [row] = await q<{ stock_quantity: number }>(
      `SELECT stock_quantity FROM products WHERE id = $1`,
      [productId],
    );
    return row.stock_quantity;
  }

  it('deletes test orders with dependent data and restores stock', async () => {
    const f = await seedScenario();
    // Eine echte Bestellung derselben Veranstaltung (vor dem Testmodus).
    const real = await seedOrder({
      orgId: f.orgId,
      eventId: f.eventId,
      productId: f.productId,
      quantity: 1,
      isTest: false,
      dailyNumber: 9,
    });
    expect(await stock(f.productId)).toBe(100 - 2 - 3 - 1);

    const result = await ds.transaction((manager) =>
      service.purge(manager, f.orgId, f.eventId),
    );

    expect(result.deletedOrderIds.sort()).toEqual([...f.testOrderIds].sort());
    expect(result.deletedPfandReturns).toBe(1);
    expect(result.restockedProducts).toEqual([
      {
        productId: f.productId,
        quantity: 5,
        quantityBefore: 94,
        quantityAfter: 99,
      },
    ]);

    // Nur die echte Bestellung bleibt, samt ihrer Zahlung.
    const orders = await q<{ id: string }>(
      `SELECT id FROM orders WHERE event_id = $1`,
      [f.eventId],
    );
    expect(orders.map((o) => o.id)).toEqual([real.orderId]);
    expect(
      await count(`order_items WHERE order_id = ANY($1::uuid[])`, [
        f.testOrderIds,
      ]),
    ).toBe(0);
    expect(
      await count(`payments WHERE order_id = ANY($1::uuid[])`, [
        f.testOrderIds,
      ]),
    ).toBe(0);
    expect(await count(`payments WHERE order_id = $1`, [real.orderId])).toBe(1);
    expect(
      await count(`print_jobs WHERE organization_id = $1`, [f.orgId]),
    ).toBe(0);
    expect(await count(`shop_checkouts WHERE event_id = $1`, [f.eventId])).toBe(
      0,
    );
    expect(await count(`pfand_returns WHERE event_id = $1`, [f.eventId])).toBe(
      1,
    );

    // Bestand: 2 + 3 zurueck, die stornierte Position nicht, das Produkt
    // ohne Bestandsfuehrung bleibt unberuehrt.
    expect(await stock(f.productId)).toBe(99);
    expect(await stock(f.untrackedProductId)).toBe(0);
    const movements = await q<{
      type: string;
      quantity: number;
      reference_type: string;
    }>(
      `SELECT type, quantity, reference_type FROM stock_movements
       WHERE event_id = $1`,
      [f.eventId],
    );
    expect(movements).toEqual([
      {
        type: 'adjustment_plus',
        quantity: 5,
        reference_type: 'test_order_cleanup',
      },
    ]);
  });

  it('is idempotent', async () => {
    const f = await seedScenario();
    await ds.transaction((manager) =>
      service.purge(manager, f.orgId, f.eventId),
    );
    const stockAfterFirst = await stock(f.productId);

    const second = await ds.transaction((manager) =>
      service.purge(manager, f.orgId, f.eventId),
    );

    expect(second.deletedOrderIds).toEqual([]);
    expect(second.deletedPfandReturns).toBe(0);
    expect(second.restockedProducts).toEqual([]);
    expect(await stock(f.productId)).toBe(stockAfterFirst);
  });

  it('leaves other events and organizations alone', async () => {
    const f = await seedScenario();
    const otherEvent = await seedEvent(f.orgId, 'inactive');
    const { productId: otherProduct } = await seedProduct(otherEvent, 50);
    await seedOrder({
      orgId: f.orgId,
      eventId: otherEvent,
      productId: otherProduct,
      quantity: 1,
      isTest: true,
      dailyNumber: 1,
    });
    const other = await seedScenario();

    await ds.transaction((manager) =>
      service.purge(manager, f.orgId, f.eventId),
    );

    expect(await count(`orders WHERE event_id = $1`, [otherEvent])).toBe(1);
    expect(await stock(otherProduct)).toBe(49);
    expect(await count(`orders WHERE event_id = $1`, [other.eventId])).toBe(4);
    expect(await stock(other.productId)).toBe(95);
    expect(
      await count(`print_jobs WHERE organization_id = $1`, [other.orgId]),
    ).toBe(2);
    expect(
      await count(`pfand_returns WHERE event_id = $1`, [other.eventId]),
    ).toBe(2);
  });

  it('does not restore stock already corrected by a later inventory count', async () => {
    const orgId = await seedOrg();
    const eventId = await seedEvent(orgId, 'test');
    const { productId } = await seedProduct(eventId, 20);
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await seedOrder({
      orgId,
      eventId,
      productId,
      quantity: 4,
      isTest: true,
      dailyNumber: 1,
      createdAt: hourAgo,
    });
    // Inventur danach: gezaehlt 20, also +4 auf den Systembestand.
    await q(`UPDATE products SET stock_quantity = 20 WHERE id = $1`, [
      productId,
    ]);
    await q(
      `INSERT INTO stock_movements (event_id, product_id, type, quantity,
         quantity_before, quantity_after, reference_type, created_at)
       VALUES ($1, $2, 'inventory_count', 4, 16, 20, 'inventory_count',
         now() - interval '30 minutes')`,
      [eventId, productId],
    );
    await seedOrder({
      orgId,
      eventId,
      productId,
      quantity: 1,
      isTest: true,
      dailyNumber: 2,
    });

    const result = await ds.transaction((manager) =>
      service.purge(manager, orgId, eventId),
    );

    expect(result.restockedProducts).toHaveLength(1);
    expect(result.restockedProducts[0].quantity).toBe(1);
    expect(await stock(productId)).toBe(20);
  });

  it('rolls everything back if the activation fails afterwards', async () => {
    const f = await seedScenario();
    const stockBefore = await stock(f.productId);

    await expect(
      ds.transaction(async (manager) => {
        await service.purge(manager, f.orgId, f.eventId);
        await manager.query(
          `UPDATE events SET status = 'active' WHERE id = $1`,
          [f.eventId],
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await count(`orders WHERE event_id = $1`, [f.eventId])).toBe(4);
    expect(await stock(f.productId)).toBe(stockBefore);
    expect(
      await count(`print_jobs WHERE organization_id = $1`, [f.orgId]),
    ).toBe(2);
    const [event] = await q<{ status: string }>(
      `SELECT status FROM events WHERE id = $1`,
      [f.eventId],
    );
    expect(event.status).toBe('test');
  });

  it('restarts pickup numbers after the test orders are gone', async () => {
    const f = await seedScenario();
    await ds.query(`UPDATE events SET status = 'active' WHERE id = $1`, [
      f.eventId,
    ]);
    await ds.transaction((manager) =>
      service.purge(manager, f.orgId, f.eventId),
    );

    const order = await saveOrderWithNumbers(
      ds.getRepository(Order),
      { organizationId: f.orgId, eventId: f.eventId },
      {},
    );

    expect(order.dailyNumber).toBe(1);
    expect(order.isTest).toBe(false);
  });

  it('marks orders created in test mode', async () => {
    const orgId = await seedOrg();
    const eventId = await seedEvent(orgId, 'test');

    const order = await saveOrderWithNumbers(
      ds.getRepository(Order),
      { organizationId: orgId, eventId },
      {},
    );

    const [row] = await q<{ is_test: boolean }>(
      `SELECT is_test FROM orders WHERE id = $1`,
      [order.id],
    );
    expect(row.is_test).toBe(true);
  });

  it('backfills existing data conservatively in the migration', async () => {
    const orgId = await seedOrg();
    const otherOrgId = await seedOrg();
    const testEvent = await seedEvent(orgId, 'test');
    const activeEvent = await seedEvent(otherOrgId, 'active');
    const { productId } = await seedProduct(testEvent, 10);
    const { productId: activeProduct } = await seedProduct(activeEvent, 10);
    const plain = await seedOrder({
      orgId,
      eventId: testEvent,
      productId,
      quantity: 1,
      isTest: false,
      dailyNumber: 1,
    });
    const printedLive = await seedOrder({
      orgId,
      eventId: testEvent,
      productId,
      quantity: 1,
      isTest: false,
      dailyNumber: 2,
    });
    const activeOrder = await seedOrder({
      orgId: otherOrgId,
      eventId: activeEvent,
      productId: activeProduct,
      quantity: 1,
      isTest: false,
      dailyNumber: 1,
    });
    const [printer] = await q<{ id: string }>(
      `INSERT INTO printers (organization_id, name, type, connection_type)
       VALUES ($1, 'Bon', 'receipt', 'network') RETURNING id`,
      [orgId],
    );
    await q(
      `INSERT INTO print_jobs (organization_id, printer_id, order_id, payload)
       VALUES ($1, $2, $3, '{"is_test": false}')`,
      [orgId, printer.id, printedLive.orderId],
    );

    // Kennzeichen entfernen und neu anlegen: das Backfill laeuft erneut.
    const runner = ds.createQueryRunner();
    const migration = new AddTestOrderMarker1816000000000();
    try {
      await migration.down(runner);
      await migration.up(runner);
    } finally {
      await runner.release();
    }

    const rows = await q<{ id: string; is_test: boolean }>(
      `SELECT id, is_test FROM orders
       WHERE organization_id = ANY($1::uuid[])`,
      [[orgId, otherOrgId]],
    );
    const flags = new Map(rows.map((r) => [r.id, r.is_test]));
    expect(flags.get(plain.orderId)).toBe(true);
    expect(flags.get(printedLive.orderId)).toBe(false);
    expect(flags.get(activeOrder.orderId)).toBe(false);
  });
});
