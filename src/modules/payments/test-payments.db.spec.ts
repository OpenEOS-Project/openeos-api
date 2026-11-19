import { INVALID_WHERE_VALUES_BEHAVIOR } from '../../config/where-values';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { CashbookService } from '../dsfinvk/cashbook.service';
import { businessDayRange } from '../dsfinvk/dsfinvk-master';
import { TestOrderCleanupService } from '../events/test-order-cleanup.service';
import { GatewayService } from '../gateway/gateway.service';
import { buildSettlementTotals } from '../waiters/waiter-settlement-math';

/**
 * Testzahlungen („Bar (Test)“, „Karte (Test)“) gegen ein echtes Postgres:
 * die Enum-Werte kommen per Migration, das Kassenbuch zaehlt sie nicht
 * als Bargeld, und beim Aktivieren verschwinden sie mit den
 * Testbestellungen (samt „Erstattungen“). Nur mit Wegwerf-Datenbank:
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://openeos:openeos@127.0.0.1:55491/openeos_tp_scratch pnpm test test-payments.db
 *
 * Name muss auf `_test` oder `_scratch` enden.
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

describeWithDb('Test payments against Postgres', () => {
  let ds: DataSource;
  const orgIds: string[] = [];

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
  }, 180_000);

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

  /** Testbestellung mit „Bar (Test)“ und echte Bestellung mit Bargeld. */
  async function seed(at: Date) {
    const orgId = randomUUID();
    orgIds.push(orgId);
    await q(
      `INSERT INTO organizations (id, name, slug, support_pin, country, operating_mode)
       VALUES ($1, 'Testverein', $2, '123456', 'AT', 'full')`,
      [orgId, `testverein-${orgId}`],
    );
    const [event] = await q<{ id: string }>(
      `INSERT INTO events (organization_id, name, status)
       VALUES ($1, 'Fest', 'test') RETURNING id`,
      [orgId],
    );
    const order = async (n: number, isTest: boolean) =>
      (
        await q<{ id: string }>(
          `INSERT INTO orders (organization_id, event_id, order_number,
             daily_number, is_test, total, paid_amount, payment_status, created_at)
           VALUES ($1, $2, $3, $4, $5, 7, 7, 'paid', $6) RETURNING id`,
          [orgId, event.id, `20260101-000${n}`, n, isTest, at],
        )
      )[0].id;
    const payment = async (orderId: string, method: string, provider: string) =>
      (
        await q<{ id: string }>(
          `INSERT INTO payments (order_id, amount, payment_method, payment_provider,
             status, created_at)
           VALUES ($1, 7, $2, $3, 'captured', $4) RETURNING id`,
          [orderId, method, provider, at],
        )
      )[0].id;
    const testOrder = await order(1, true);
    const testCardOrder = await order(2, true);
    const realOrder = await order(3, false);
    const testCash = await payment(testOrder, 'test_cash', 'TEST');
    const testCard = await payment(testCardOrder, 'test_card', 'TEST');
    await payment(realOrder, 'cash', 'CASH');
    // „Erstattung“ der Testzahlung: zurueck auf die Testzahlung, Status test.
    await q(
      `INSERT INTO refunds (organization_id, order_id, payment_id, event_id,
         refund_number, kind, amount, payment_method, status, provider,
         reason_code, is_test, created_at)
       VALUES ($1, $2, $3, $4, '20260101-0001-E1', 'refund', -7, 'test_cash',
         'test', 'TEST', 'other', true, $5)`,
      [orgId, testOrder, testCash, event.id, at],
    );
    return { orgId, eventId: event.id, testOrder, testCardOrder, testCard };
  }

  it('stores test payments and keeps them out of the cashbook', async () => {
    const day = '2026-06-10';
    const { from } = businessDayRange(day);
    const at = new Date(from.getTime() + 3 * 3600_000);
    const { orgId } = await seed(at);

    const cashbook = new CashbookService(
      ds,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    const { expectedCents } = await cashbook.summary(orgId, day, '*' as never);
    // Nur die echte Barzahlung (7,00 €) zaehlt, nicht „Bar (Test)“ und
    // nicht die „Erstattung“ darauf.
    expect(expectedCents).toBe(700);
  });

  it('deletes test payments and their refunds with the test orders on activation', async () => {
    const { orgId, eventId, testOrder, testCardOrder } = await seed(new Date());
    const purge = await new TestOrderCleanupService({} as GatewayService).purge(
      ds.manager,
      orgId,
      eventId,
    );
    expect(purge.deletedOrderIds.sort()).toEqual(
      [testOrder, testCardOrder].sort(),
    );
    const left = await q<{ method: string }>(
      `SELECT p.payment_method::text AS method FROM payments p
         JOIN orders o ON o.id = p.order_id WHERE o.organization_id = $1`,
      [orgId],
    );
    expect(left).toEqual([{ method: 'cash' }]);
    const refunds = await q(
      `SELECT id FROM refunds WHERE organization_id = $1`,
      [orgId],
    );
    expect(refunds).toHaveLength(0);
  });
});

describe('Test payments in the waiter settlement', () => {
  it('count as training („Training (nicht im Geld)“), never as cash', () => {
    const row = (
      method: string,
      isTest: boolean,
      count: number,
      amount: number,
    ) => ({
      method,
      isTest,
      deviceId: 'device-1',
      deviceName: 'Kasse 1',
      count,
      amount,
      tip: 0,
    });
    const totals = buildSettlementTotals({
      operatingMode: 'full',
      payments: [
        row('test_cash', true, 2, 14),
        row('test_card', true, 1, 5),
        row('cash', false, 1, 10),
      ],
      refunds: [{ method: 'test_cash', isTest: true, count: 1, amount: -7 }],
      pfandReturns: [],
      taken: [],
      items: [],
    });
    expect(totals.payments?.cash.amount).toBe(10);
    expect(totals.payments?.total.amount).toBe(10);
    expect(totals.refunds?.total.count ?? 0).toBe(0);
    expect(totals.training).toMatchObject({ payments: 3, amount: 19 });
  });
});
