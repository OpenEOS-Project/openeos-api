/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Zeilen aus SQL */
import { randomUUID } from 'crypto';
import * as path from 'path';
import { HttpException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ErrorReasons } from '../../common/constants/error-codes';
import type { CronLockService } from '../../common/redis/cron-lock.service';
import {
  Category,
  Device,
  Order,
  OrderItem,
  Organization,
  Payment,
  PfandReturn,
  Printer,
  PrintJob,
  Product,
  RetentionRun,
  StockMovement,
  User,
  UserOrganization,
} from '../../database/entities';
import { TestOrderCleanupService } from '../events/test-order-cleanup.service';
import type { GatewayService } from '../gateway/gateway.service';
import { ReportsService } from '../reports/reports.service';
import { WaiterDataJob } from '../retention/jobs/waiter-data.job';
import { loadRetentionConfig } from '../retention/retention.config';
import { RetentionService } from '../retention/retention.service';
import { rowsOf } from '../tse/tse-sql.util';
import { DeviceWaitersController } from './device-waiters.controller';
import { PinCredentialsService } from './pin-credentials.service';
import { PinLockoutService } from './pin-lockout.service';
import { waiterExportCsv } from './waiter-export';
import {
  memberOperator,
  waiterOperator,
  type Operator,
} from './waiter-operator';
import { retireEventWaiters } from './waiter-retire';
import { WaiterSessionsService } from './waiter-sessions.service';
import { WaiterSettlementsService } from './waiter-settlements.service';
import { WaiterTransferService } from './waiter-transfer.service';
import { WaitersService } from './waiters.service';

/**
 * Kellnerabrechnung, Tischuebergabe und Datenschutz der Bedienungen gegen
 * ein echtes Postgres (bedienungen-plan.md §7, §10):
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://openeos:openeos@127.0.0.1:55460/openeos_waiters2_test pnpm test waiter-settlements.db
 *
 * Name muss auf `_test` oder `_scratch` enden.
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

const offlineRedis = new Proxy(
  {},
  { get: () => () => Promise.reject(new Error('redis offline (test)')) },
);

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const secondsAgo = (s: number) => new Date(Date.now() - s * 1000);

async function reasonOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    return (error.getResponse() as { reason?: string }).reason ?? null;
  }
}

type Row = Record<string, any>;

describeWithDb('Kellnerabrechnung against Postgres', () => {
  let ds: DataSource;
  let sessions: WaiterSessionsService;
  let waiters: WaitersService;
  let settlements: WaiterSettlementsService;
  let transfers: WaiterTransferService;
  let device: DeviceWaitersController;
  let reports: ReportsService;
  let retention: RetentionService;
  const gatewayEvents: { name: string; payload: unknown }[] = [];
  const orgIds: string[] = [];
  const userIds: string[] = [];
  const config = (values: Record<string, unknown>) =>
    ({ get: (key: string) => values[key] }) as never;

  const sql = async (text: string, params: unknown[] = []): Promise<Row[]> =>
    rowsOf<Row>(await ds.query(text, params));
  const one = async (text: string, params: unknown[] = []): Promise<Row> =>
    (await sql(text, params))[0];

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
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
    const pins = new PinCredentialsService(
      ds,
      config({ PIN_PEPPER: 'db-spec-pepper-0123456789abcdef' }),
    );
    const lockout = new PinLockoutService(offlineRedis as never, ds);
    sessions = new WaiterSessionsService(ds, pins, lockout);
    sessions.minResponseMs = 0;
    waiters = new WaitersService(
      ds,
      pins,
      sessions,
      config({ 'limits.waitersPerOrganization': 200 }),
    );
    settlements = new WaiterSettlementsService(ds);
    const gateway = {
      notifyOrderTransferred: (_org: string, payload: unknown) =>
        gatewayEvents.push({ name: 'orderTransferred', payload }),
      notifyTablesUpdated: () =>
        gatewayEvents.push({ name: 'tablesUpdated', payload: null }),
      notifyWaiterUpdated: () => undefined,
    } as unknown as GatewayService;
    transfers = new WaiterTransferService(ds, gateway);
    device = new DeviceWaitersController(sessions, ds, settlements, transfers);
    reports = new ReportsService(
      ds.getRepository(Order),
      ds.getRepository(OrderItem),
      ds.getRepository(Payment),
      ds.getRepository(Product),
      ds.getRepository(Category),
      ds.getRepository(StockMovement),
      ds.getRepository(PfandReturn),
      ds.getRepository(UserOrganization),
      ds.getRepository(Device),
      ds.getRepository(Printer),
      ds.getRepository(PrintJob),
      config({}),
      ds.getRepository(Organization),
    );
    retention = new RetentionService(
      ds,
      ds.getRepository(RetentionRun),
      loadRetentionConfig({ RETENTION_DRY_RUN: 'false' }),
      [new WaiterDataJob()],
      {
        runExclusive: async (_n: string, job: () => Promise<void>) => {
          await job();
          return true;
        },
      } as unknown as CronLockService,
    );
  }, 120_000);

  afterAll(async () => {
    if (ds?.isInitialized) {
      if (orgIds.length) {
        for (const table of ['tse_transactions', 'cash_registers']) {
          await sql(
            `DELETE FROM ${table} WHERE organization_id = ANY($1::uuid[])`,
            [orgIds],
          );
        }
        await sql(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [
          orgIds,
        ]);
      }
      if (userIds.length) {
        await sql(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
      }
      await ds.destroy();
    }
  });

  // ---------------------------------------------------------------- Fixtures

  interface World {
    orgId: string;
    eventId: string;
    productId: string;
    categoryId: string;
    deviceA: string;
    deviceB: string;
    admin: User;
  }

  async function world(
    o: { mode?: string; eventStatus?: string; selfSettlement?: boolean } = {},
  ): Promise<World> {
    const orgId = randomUUID();
    orgIds.push(orgId);
    await sql(
      `INSERT INTO organizations (id, name, slug, support_pin, settings, country, operating_mode)
       VALUES ($1, 'Feuerwehr', $2, '123456', $3, 'AT', $4)`,
      [
        orgId,
        `ff-${orgId}`,
        JSON.stringify({
          waiters: { selfSettlement: o.selfSettlement === true },
        }),
        o.mode ?? 'full',
      ],
    );
    const [{ id: eventId }] = await sql(
      `INSERT INTO events (organization_id, name, start_date, end_date, status)
       VALUES ($1, 'Sommerfest', now() - interval '1 day', now() + interval '1 day', $2) RETURNING id`,
      [orgId, o.eventStatus ?? 'active'],
    );
    const [{ id: categoryId }] = await sql(
      `INSERT INTO categories (event_id, name) VALUES ($1, 'Getränke') RETURNING id`,
      [eventId],
    );
    const [{ id: productId }] = await sql(
      `INSERT INTO products (event_id, category_id, name, price) VALUES ($1, $2, 'Radler', 3.5) RETURNING id`,
      [eventId, categoryId],
    );
    const dev = async (name: string) =>
      (
        await one(
          `INSERT INTO devices (organization_id, name, type, device_token, settings, status)
           VALUES ($1, $2, 'pos', $3, '{"waiterMode":"shared"}', 'verified') RETURNING id`,
          [orgId, name, `tok-${randomUUID()}`],
        )
      ).id as string;
    const userId = randomUUID();
    userIds.push(userId);
    await sql(
      `INSERT INTO users (id, email, first_name, last_name) VALUES ($1, $2, 'Markus', 'Maier')`,
      [userId, `s-${userId}@example.com`],
    );
    await sql(
      `INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1, $2, 'admin')`,
      [userId, orgId],
    );
    return {
      orgId,
      eventId,
      productId,
      categoryId,
      deviceA: await dev('Kasse Theke'),
      deviceB: await dev('Kasse Zelt'),
      admin: { id: userId } as User,
    };
  }

  async function waiter(
    w: World,
    name: string,
    o: { role?: 'service' | 'lead'; eventId?: string | null } = {},
  ) {
    const created = await waiters.create(
      w.orgId,
      {
        name,
        role: o.role ?? 'service',
        eventId: o.eventId === undefined ? null : (o.eventId ?? undefined),
      },
      w.admin,
    );
    const row = await one(`SELECT * FROM waiters WHERE id = $1`, [created.id]);
    return {
      id: created.id,
      pin: created.pin,
      operator: waiterOperator(
        {
          id: row.id,
          name: row.name,
          shortName: row.short_name,
          color: row.color,
          role: row.role,
          permissions: row.permissions,
        },
        null,
      ),
    };
  }

  /** Bestellung mit einer Position; optional bezahlt. */
  async function order(
    w: World,
    o: {
      creator?: string | null;
      owner?: string | null;
      total?: number;
      paid?: number;
      isTest?: boolean;
      table?: string | null;
      createdAt?: Date;
      discount?: number;
      quantity?: number;
    } = {},
  ): Promise<string> {
    const total = o.total ?? 7;
    const paid = o.paid ?? 0;
    const status = paid >= total ? 'completed' : 'open';
    const paymentStatus =
      paid >= total ? 'paid' : paid > 0 ? 'partly_paid' : 'unpaid';
    const { id } = await one(
      `INSERT INTO orders (organization_id, event_id, order_number, daily_number, status, payment_status,
                           source, total, subtotal, paid_amount, discount_amount, is_test, table_number,
                           created_by_waiter_id, waiter_id, created_at)
       VALUES ($1, $2, $3, (SELECT COALESCE(max(daily_number), 0) + 1 FROM orders WHERE organization_id = $1),
               $4, $5, 'pos', $6, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [
        w.orgId,
        w.eventId,
        `A-${randomUUID().slice(0, 8)}`,
        status,
        paymentStatus,
        total,
        paid,
        o.discount ?? 0,
        o.isTest === true,
        o.table ?? null,
        o.creator ?? null,
        o.owner === undefined ? (o.creator ?? null) : o.owner,
        o.createdAt ?? secondsAgo(60),
      ],
    );
    await sql(
      `INSERT INTO order_items (order_id, product_id, category_id, product_name, category_name,
                                quantity, unit_price, total_price, tax_rate, added_by_waiter_id, created_at)
       VALUES ($1, $2, $3, 'Radler', 'Getränke', $4, 3.5, $5, 19, $6, $7)`,
      [
        id,
        w.productId,
        w.categoryId,
        o.quantity ?? 2,
        total,
        o.creator ?? null,
        o.createdAt ?? secondsAgo(60),
      ],
    );
    return id;
  }

  async function payment(
    orderId: string,
    o: {
      method?: string;
      amount: number;
      tip?: number;
      waiterId?: string | null;
      userId?: string | null;
      deviceId?: string | null;
      createdAt?: Date;
    },
  ): Promise<string> {
    const { id } = await one(
      `INSERT INTO payments (order_id, amount, payment_method, payment_provider, status, tip_amount,
                             processed_by_waiter_id, processed_by_user_id, processed_by_device_id, created_at)
       VALUES ($1, $2, $3, 'CASH', 'captured', $4, $5, $6, $7, $8) RETURNING id`,
      [
        orderId,
        o.amount,
        o.method ?? 'cash',
        o.tip ?? 0,
        o.waiterId ?? null,
        o.userId ?? null,
        o.deviceId ?? null,
        o.createdAt ?? secondsAgo(50),
      ],
    );
    return id;
  }

  async function refund(
    w: World,
    orderId: string,
    o: {
      amount: number;
      method?: string;
      waiterId?: string | null;
      deviceId?: string | null;
      isTest?: boolean;
      actorName?: string;
    },
  ) {
    await sql(
      `INSERT INTO refunds (organization_id, order_id, event_id, refund_number, kind, amount, payment_method,
                            status, provider, reason_code, waiter_id, device_id, is_test, actor_name, created_at)
       VALUES ($1, $2, $3, $4, 'refund', $5, $6, 'completed', 'cash', 'quality', $7, $8, $9, $10, $11)`,
      [
        w.orgId,
        orderId,
        w.eventId,
        `R-${randomUUID().slice(0, 8)}`,
        -Math.abs(o.amount),
        o.method ?? 'cash',
        o.waiterId ?? null,
        o.deviceId ?? null,
        o.isTest === true,
        o.actorName ?? null,
        secondsAgo(40),
      ],
    );
  }

  async function pfand(
    w: World,
    o: { amount: number; waiterId: string; deviceId?: string | null },
  ) {
    await sql(
      `INSERT INTO pfand_returns (organization_id, event_id, device_id, waiter_id, total_amount, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        w.orgId,
        w.eventId,
        o.deviceId ?? null,
        o.waiterId,
        o.amount,
        secondsAgo(30),
      ],
    );
  }

  const deviceRef = (w: World, id = w.deviceA) =>
    ({
      id,
      organizationId: w.orgId,
      name: id === w.deviceA ? 'Kasse Theke' : 'Kasse Zelt',
      settings: { waiterMode: 'shared' },
    }) as unknown as Device;

  // ------------------------------------------------------------- Rechnung

  it('sums cash, card, tips, refunds and deposits per server; test orders only count as training', async () => {
    const w = await world();
    const anna = await waiter(w, 'Anna Berger');
    const ben = await waiter(w, 'Ben Krause');

    // Anna: bar 10 (Trinkgeld 1) an der Theke, Karte 20 (Trinkgeld 2) am Zelt.
    const o1 = await order(w, {
      creator: anna.id,
      total: 10,
      paid: 10,
      discount: 1,
    });
    await payment(o1, {
      amount: 10,
      tip: 1,
      waiterId: anna.id,
      deviceId: w.deviceA,
    });
    const o2 = await order(w, {
      creator: anna.id,
      total: 20,
      paid: 20,
      quantity: 4,
    });
    await payment(o2, {
      amount: 20,
      tip: 2,
      method: 'sumup_terminal',
      waiterId: anna.id,
      deviceId: w.deviceB,
    });
    // Anna kassiert Bens Tisch bar am Zelt: zaehlt fuer Anna (Entscheidung 6).
    const o3 = await order(w, { creator: ben.id, total: 5, paid: 5 });
    await payment(o3, { amount: 5, waiterId: anna.id, deviceId: w.deviceB });
    // PayPal zaehlt als „sonstige“.
    const o4 = await order(w, { creator: anna.id, total: 4, paid: 4 });
    await payment(o4, { amount: 4, method: 'paypal', waiterId: anna.id });
    // Bar-Erstattung 3 und unbare 2 von Anna; Pfand 2 an der Theke.
    await refund(w, o1, { amount: 3, waiterId: anna.id, deviceId: w.deviceA });
    await refund(w, o2, {
      amount: 2,
      method: 'sumup_terminal',
      waiterId: anna.id,
    });
    await pfand(w, { amount: 2, waiterId: anna.id, deviceId: w.deviceA });
    // Testbuchung: nur Training, nie im Geld.
    const test = await order(w, {
      creator: anna.id,
      total: 50,
      paid: 50,
      isTest: true,
    });
    await payment(test, { amount: 50, waiterId: anna.id, deviceId: w.deviceA });
    await refund(w, test, { amount: 50, waiterId: anna.id, isTest: true });

    const summary = await settlements.summary(w.orgId, {
      kind: 'waiter',
      waiterId: anna.id,
    });
    const t = summary.totals;
    expect(summary.eventId).toBe(w.eventId);
    expect(summary.periodFrom).toBeNull();
    expect(t.payments).toEqual({
      cash: { count: 2, amount: 15 },
      card: { count: 1, amount: 20 },
      other: { count: 1, amount: 4 },
      total: { count: 4, amount: 39 },
    });
    expect(t.tips).toBe(3);
    expect(t.refunds).toEqual({
      cash: { count: 1, amount: 3 },
      nonCash: { count: 1, amount: 2 },
      total: { count: 2, amount: 5 },
    });
    expect(t.pfandReturns).toEqual({ count: 1, amount: 2 });
    // Aufgenommen: o1, o2, o4 (o3 hat Ben aufgenommen), Testbestellung nicht.
    expect(t.taken).toEqual({ orders: 3, items: 8, revenue: 34, discounts: 1 });
    // Soll bar = 15 − 3 − 2; Theke 10 − 3 − 2 = 5, Zelt 5.
    expect(t.cashExpected).toBe(10);
    expect(t.cashByDevice).toEqual(
      expect.arrayContaining([
        { deviceId: w.deviceA, deviceName: 'Kasse Theke', amount: 5 },
        { deviceId: w.deviceB, deviceName: 'Kasse Zelt', amount: 5 },
      ]),
    );
    expect(t.training).toEqual({ orders: 1, payments: 1, amount: 50 });
    expect(summary.openTables).toEqual([]);
    expect(summary.empty).toBe(false);

    // Report: dieselben Zahlen je Bedienung, Testbuchungen nicht.
    const report = await reports.getWaitersReport(
      w.orgId,
      { eventId: w.eventId },
      w.admin,
    );
    const annaRow = report.find((r) => r.waiterId === anna.id)!;
    expect(annaRow).toMatchObject({
      kind: 'waiter',
      name: 'Anna Berger',
      orders: 3,
      items: 8,
      payments: 4,
      collected: 39,
      cashAmount: 15,
      cardAmount: 20,
      otherAmount: 4,
      tips: 3,
      refundCount: 2,
      refunds: 5,
      pfandReturned: 2,
      settlements: 0,
      openOrders: 0,
    });
    expect(report.find((r) => r.waiterId === ben.id)).toMatchObject({
      orders: 1,
      payments: 0,
    });
  });

  it('settles with a running number per organisation and keeps the settlement immutable', async () => {
    const w = await world();
    const anna = await waiter(w, 'Anna Berger');
    const lea = await waiter(w, 'Lea Schmidt', { role: 'lead' });
    const o1 = await order(w, { creator: anna.id, total: 10, paid: 10 });
    await payment(o1, { amount: 10, waiterId: anna.id, deviceId: w.deviceA });

    const first = await settlements.settle(
      w.orgId,
      { kind: 'waiter', waiterId: anna.id },
      { userId: null, waiterId: lea.id, mayForce: true, deviceId: w.deviceA },
      { countedCash: 9.5 },
    );
    expect(first.settlement).toMatchObject({
      number: 1,
      isTest: false,
      cashExpected: 10,
      cashCounted: 9.5,
      difference: -0.5,
      wallet: false,
      forced: false,
      deviceName: 'Kasse Theke',
      settledBy: { kind: 'waiter', id: lea.id, name: 'Lea Schmidt' },
      subject: { kind: 'waiter', id: anna.id, name: 'Anna Berger' },
    });
    expect(first.printed).toBe(false);

    // Nichts Neues seit der Abrechnung.
    expect(
      await reasonOf(
        settlements.settle(
          w.orgId,
          { kind: 'waiter', waiterId: anna.id },
          { userId: w.admin.id, waiterId: null, mayForce: true },
        ),
      ),
    ).toBe(ErrorReasons.WAITER_SETTLEMENT_EMPTY);

    // Unveraenderlich: Zahlen, Nummer, Person; Loeschen ausgeschlossen.
    const id = first.settlement.id;
    await expect(
      sql(`UPDATE waiter_settlements SET number = 99 WHERE id = $1`, [id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      sql(`UPDATE waiter_settlements SET totals = '{}'::jsonb WHERE id = $1`, [
        id,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      sql(`DELETE FROM waiter_settlements WHERE id = $1`, [id]),
    ).rejects.toThrow(/cannot be deleted/);
    // Nur der Druckzeitpunkt darf sich aendern.
    await sql(
      `UPDATE waiter_settlements SET printed_at = now() WHERE id = $1`,
      [id],
    );

    // Neuer Zeitraum beginnt am Ende des vorigen; Nummer 2.
    const o2 = await order(w, {
      creator: anna.id,
      total: 4,
      paid: 4,
      createdAt: new Date(),
    });
    await payment(o2, { amount: 4, waiterId: anna.id, createdAt: new Date() });
    const summary = await settlements.summary(w.orgId, {
      kind: 'waiter',
      waiterId: anna.id,
    });
    expect(new Date(summary.periodFrom!).getTime()).toBe(
      new Date(first.settlement.periodTo).getTime(),
    );
    expect(summary.totals.payments?.total).toEqual({ count: 1, amount: 4 });
    expect(summary.lastSettlement?.number).toBe(1);
    const second = await settlements.settle(
      w.orgId,
      { kind: 'waiter', waiterId: anna.id },
      { userId: w.admin.id, waiterId: null, mayForce: true },
    );
    expect(second.settlement.number).toBe(2);
    expect(second.settlement.settledBy).toMatchObject({
      kind: 'user',
      name: 'Markus Maier',
    });

    const list = await settlements.list(w.orgId, { waiterId: anna.id });
    expect(list.map((s) => s.number)).toEqual([2, 1]);
  });

  it('blocks settling with open tables unless a lead forces it with a note', async () => {
    const w = await world();
    const anna = await waiter(w, 'Anna Berger');
    const paid = await order(w, { creator: anna.id, total: 6, paid: 6 });
    await payment(paid, { amount: 6, waiterId: anna.id });
    await order(w, { creator: anna.id, total: 12, paid: 5, table: '7' });

    const subject = { kind: 'waiter' as const, waiterId: anna.id };
    let caught: HttpException | null = null;
    try {
      await settlements.settle(w.orgId, subject, {
        userId: w.admin.id,
        waiterId: null,
        mayForce: true,
      });
    } catch (error) {
      caught = error as HttpException;
    }
    expect(caught?.getStatus()).toBe(409);
    const body = caught!.getResponse() as Row;
    expect(body.reason).toBe(ErrorReasons.WAITER_OPEN_TABLES);
    expect(body.params.openTables).toEqual([
      expect.objectContaining({ tableNumber: '7', openAmount: 7 }),
    ]);

    expect(
      await reasonOf(
        settlements.settle(
          w.orgId,
          subject,
          { userId: null, waiterId: anna.id, mayForce: false },
          { force: true, note: 'Gast zahlt morgen' },
        ),
      ),
    ).toBe(ErrorReasons.WAITER_NOT_PERMITTED);
    expect(
      await reasonOf(
        settlements.settle(
          w.orgId,
          subject,
          { userId: w.admin.id, waiterId: null, mayForce: true },
          { force: true, note: '  ' },
        ),
      ),
    ).toBe(ErrorReasons.WAITER_SETTLEMENT_NOTE_REQUIRED);

    const forced = await settlements.settle(
      w.orgId,
      subject,
      { userId: w.admin.id, waiterId: null, mayForce: true },
      { force: true, note: 'Gast zahlt morgen' },
    );
    expect(forced.settlement).toMatchObject({
      forced: true,
      note: 'Gast zahlt morgen',
      openTables: [expect.objectContaining({ tableNumber: '7' })],
    });
  });

  it('settles training-only periods without a number and drops them with the test purge', async () => {
    const w = await world({ eventStatus: 'test' });
    const anna = await waiter(w, 'Anna Berger');
    const test = await order(w, {
      creator: anna.id,
      total: 3,
      paid: 3,
      isTest: true,
    });
    await payment(test, { amount: 3, waiterId: anna.id });
    const { settlement } = await settlements.settle(
      w.orgId,
      { kind: 'waiter', waiterId: anna.id },
      { userId: w.admin.id, waiterId: null, mayForce: true },
    );
    expect(settlement).toMatchObject({ isTest: true, number: null });
    expect(settlement.totals.training).toEqual({
      orders: 1,
      payments: 1,
      amount: 3,
    });

    await ds.transaction((manager) =>
      new TestOrderCleanupService({} as GatewayService).purge(
        manager,
        w.orgId,
        w.eventId,
      ),
    );
    expect(
      await sql(`SELECT id FROM waiter_settlements WHERE id = $1`, [
        settlement.id,
      ]),
    ).toEqual([]);
  });

  it('shows only quantities in the „Nur Bons“ mode and does not block on open orders', async () => {
    const w = await world({ mode: 'orders_only' });
    const anna = await waiter(w, 'Anna Berger');
    await order(w, { creator: anna.id, total: 7, quantity: 3 });
    const summary = await settlements.summary(w.orgId, {
      kind: 'waiter',
      waiterId: anna.id,
    });
    expect(summary.totals).toEqual({
      operatingMode: 'orders_only',
      taken: { orders: 1, items: 3 },
      training: { orders: 0, payments: 0 },
    });
    expect(summary.openTables).toEqual([]);
    const { settlement } = await settlements.settle(
      w.orgId,
      { kind: 'waiter', waiterId: anna.id },
      { userId: w.admin.id, waiterId: null, mayForce: true },
    );
    expect(settlement.cashExpected).toBeNull();
    expect(settlement.number).toBe(1);
  });

  // ------------------------------------------------------------- Kasse

  it('lets a server see the own summary; settling needs a lead (or self-settlement)', async () => {
    const w = await world();
    const anna = await waiter(w, 'Anna Berger');
    const ben = await waiter(w, 'Ben Krause');
    const lea = await waiter(w, 'Lea Schmidt', { role: 'lead' });
    const o = await order(w, { creator: anna.id, total: 5, paid: 5 });
    await payment(o, { amount: 5, waiterId: anna.id, deviceId: w.deviceA });
    const dev = deviceRef(w);

    const own = await device.summary(dev, anna.operator);
    expect(own.data.subject.id).toBe(anna.id);
    expect(own.meta).toEqual({ canSettle: false, canForce: false });
    expect(await reasonOf(device.summary(dev, anna.operator, ben.id))).toBe(
      ErrorReasons.WAITER_NOT_PERMITTED,
    );
    expect(await reasonOf(device.summary(dev, null))).toBe(
      ErrorReasons.WAITER_SESSION_REQUIRED,
    );
    expect(await reasonOf(device.settle(dev, anna.operator, {}))).toBe(
      ErrorReasons.WAITER_NOT_PERMITTED,
    );

    // Schichtleitung rechnet Anna ab; Bon nur ohne Druckdienst nicht.
    const byLead = await device.settle(dev, lea.operator, {
      waiterId: anna.id,
    });
    expect(byLead.data).toMatchObject({
      number: 1,
      deviceId: w.deviceA,
      settledBy: { kind: 'waiter', id: lea.id },
    });

    // Organisation erlaubt Selbstabrechnung: Ben rechnet sich selbst ab,
    // aber niemand anderen und nie „trotz offener Tische“.
    await sql(
      `UPDATE organizations SET settings = '{"waiters":{"selfSettlement":true}}' WHERE id = $1`,
      [w.orgId],
    );
    const ob = await order(w, { creator: ben.id, total: 3, paid: 3 });
    await payment(ob, { amount: 3, waiterId: ben.id });
    await order(w, { creator: ben.id, total: 8, table: '3' });
    expect((await device.summary(dev, ben.operator)).meta).toEqual({
      canSettle: true,
      canForce: false,
    });
    expect(
      await reasonOf(
        device.settle(dev, ben.operator, { force: true, note: 'später' }),
      ),
    ).toBe(ErrorReasons.WAITER_NOT_PERMITTED);
    expect(
      await reasonOf(device.settle(dev, ben.operator, { waiterId: anna.id })),
    ).toBe(ErrorReasons.WAITER_NOT_PERMITTED);

    // Mitglied (Admin) mit Mitglieds-PIN: darf abrechnen.
    const admin: Operator = memberOperator(
      { userId: w.admin.id, role: 'admin' as never, permissions: {} },
      { firstName: 'Markus', lastName: 'Maier' },
      null,
    );
    const forced = await device.settle(dev, admin, {
      waiterId: ben.id,
      force: true,
      note: 'Tisch 3 zahlt am Ausgang',
    });
    expect(forced.data).toMatchObject({
      forced: true,
      settledBy: { kind: 'user' },
    });
  });

  it('hands over tables: own ones by anyone, foreign ones by a lead; logged and broadcast', async () => {
    const w = await world();
    const anna = await waiter(w, 'Anna Berger');
    const ben = await waiter(w, 'Ben Krause');
    const lea = await waiter(w, 'Lea Schmidt', { role: 'lead' });
    const dev = deviceRef(w);
    const t5a = await order(w, { creator: anna.id, total: 6, table: '5' });
    const t5b = await order(w, { creator: anna.id, total: 4, table: ' 5 ' });
    const t9 = await order(w, { creator: anna.id, total: 9, table: '9' });
    const done = await order(w, {
      creator: anna.id,
      total: 2,
      paid: 2,
      table: '5',
    });

    // Ben darf Annas Tisch nicht übergeben.
    expect(
      await reasonOf(
        device.transfer(dev, ben.operator, t9, { toWaiterId: ben.id }),
      ),
    ).toBe(ErrorReasons.WAITER_NOT_PERMITTED);

    gatewayEvents.length = 0;
    const own = await device.transfer(dev, anna.operator, t5a, {
      toWaiterId: ben.id,
    });
    expect(own.data.orderIds.sort()).toEqual([t5a, t5b].sort());
    expect(gatewayEvents.map((e) => e.name)).toEqual([
      'orderTransferred',
      'tablesUpdated',
    ]);
    expect(gatewayEvents[0].payload).toMatchObject({
      toWaiterId: ben.id,
      fromWaiterId: anna.id,
      tableNumber: '5',
    });
    const owners = await sql(
      `SELECT id, waiter_id, created_by_waiter_id FROM orders WHERE id = ANY($1::uuid[])`,
      [[t5a, t5b, t9, done]],
    );
    const ownerOf = (id: string) => owners.find((r) => r.id === id)!;
    expect(ownerOf(t5a).waiter_id).toBe(ben.id);
    expect(ownerOf(t5a).created_by_waiter_id).toBe(anna.id);
    expect(ownerOf(t5b).waiter_id).toBe(ben.id);
    expect(ownerOf(t9).waiter_id).toBe(anna.id);
    expect(ownerOf(done).waiter_id).toBe(anna.id);
    const [logged] = await sql(
      `SELECT type, waiter_id, actor_name, device_id, data FROM order_events WHERE order_id = $1`,
      [t5a],
    );
    expect(logged).toMatchObject({
      type: 'transferred',
      waiter_id: anna.id,
      actor_name: 'Anna Berger',
      device_id: w.deviceA,
      data: { fromWaiterId: anna.id, toWaiterId: ben.id },
    });

    // Abgeschlossene Bestellungen nicht; die Schichtleitung übergibt fremde.
    expect(
      await reasonOf(
        device.transfer(dev, lea.operator, done, { toWaiterId: ben.id }),
      ),
    ).toBe(ErrorReasons.WAITER_TRANSFER_INVALID);
    await device.transfer(dev, lea.operator, t9, { toWaiterId: ben.id });
    expect(
      (await one(`SELECT waiter_id FROM orders WHERE id = $1`, [t9])).waiter_id,
    ).toBe(ben.id);

    // Verwaltung: alle offenen Tische von Ben an Lea (vor der Abrechnung).
    const moved = await transfers.transferAllOpen(w.orgId, ben.id, lea.id, {
      admin: true,
      userId: w.admin.id,
    });
    expect(moved.orderIds.sort()).toEqual([t5a, t5b, t9].sort());
    expect(
      (await settlements.summary(w.orgId, { kind: 'waiter', waiterId: ben.id }))
        .openTables,
    ).toEqual([]);
  });

  // --------------------------------------------------------- Datenschutz

  it('anonymises servers after the periods, pseudonymises protocols, keeps the tax archive (with dry run)', async () => {
    const w = await world();
    const now = new Date();
    // Veranstaltung vor 40 Tagen zu Ende.
    await sql(
      `UPDATE events SET end_date = $2, status = 'inactive' WHERE id = $1`,
      [w.eventId, ago(40)],
    );
    const anna = await waiter(w, 'Anna Berger', { eventId: w.eventId });
    const nobody = await waiter(w, 'Ohne Buchung', { eventId: w.eventId });
    const old = await waiter(w, 'Olaf Alt');
    const idle = await waiter(w, 'Ida Lang');
    const fresh = await waiter(w, 'Frieda Neu');
    const o = await order(w, { creator: anna.id, total: 5, paid: 5 });
    await payment(o, { amount: 5, waiterId: anna.id });
    await refund(w, o, {
      amount: 1,
      waiterId: anna.id,
      actorName: 'Anna Berger',
    });
    await sql(
      `INSERT INTO order_events (organization_id, order_id, type, waiter_id, actor_name)
       VALUES ($1, $2, 'refunded', $3, 'Anna Berger')`,
      [w.orgId, o, anna.id],
    );
    await sql(
      `INSERT INTO tse_transactions (organization_id, kind, process_type, process_data, status, client_id,
                                     waiter_id, operator_name)
       VALUES ($1, 'receipt', 'Kassenbeleg-V1', 'Beleg^5.00', 'signed', 'OEOS-TEST', $2, 'Anna Berger')`,
      [w.orgId, anna.id],
    );
    // Olaf: seit 31 Tagen deaktiviert, mit Buchung; Ida: 13 Monate nicht genutzt.
    const oo = await order(w, { creator: old.id, total: 2, paid: 2 });
    await payment(oo, { amount: 2, waiterId: old.id });
    await sql(
      `UPDATE waiters SET is_active = false, deactivated_at = $2 WHERE id = $1`,
      [old.id, ago(31)],
    );
    await sql(
      `UPDATE waiters SET created_at = $2, last_used_at = $2 WHERE id = $1`,
      [idle.id, ago(400)],
    );
    // Sitzungen: alt (100 Tage) und frisch.
    for (const startedAt of [ago(100), ago(5)]) {
      await sql(
        `INSERT INTO waiter_sessions (organization_id, device_id, waiter_id, token_hash, started_at, last_seen_at, ended_at, end_reason)
         VALUES ($1, $2, $3, $4, $5, $5, $5, 'lock')`,
        [
          w.orgId,
          w.deviceA,
          fresh.id,
          randomUUID().replace(/-/g, '').padEnd(64, '0'),
          startedAt,
        ],
      );
    }

    const before = await sql(
      `SELECT id, name, anonymized_at FROM waiters WHERE organization_id = $1 ORDER BY name`,
      [w.orgId],
    );
    // Probelauf: zaehlt, aendert nichts.
    const [dry] = await retention.runAll(
      { trigger: 'manual', dryRun: true, now },
      ['waiter_data'],
    );
    expect(dry.status).toBe('succeeded');
    expect(dry.counts).toMatchObject({
      waitersAnonymised: 2,
      waitersDeleted: 2,
      sessionsDeleted: 1,
    });
    expect(
      await sql(
        `SELECT id, name, anonymized_at FROM waiters WHERE organization_id = $1 ORDER BY name`,
        [w.orgId],
      ),
    ).toEqual(before);

    const [real] = await retention.runAll(
      { trigger: 'manual', dryRun: false, now },
      ['waiter_data'],
    );
    expect(real.status).toBe('succeeded');
    const rows = await sql(
      `SELECT id, name, short_name, color, is_active, anonymized_at FROM waiters WHERE organization_id = $1`,
      [w.orgId],
    );
    const byId = (id: string) => rows.find((r) => r.id === id);
    expect(byId(nobody.id)).toBeUndefined();
    expect(byId(idle.id)).toBeUndefined();
    expect(byId(fresh.id)).toMatchObject({
      name: 'Frieda Neu',
      anonymized_at: null,
    });
    for (const id of [anna.id, old.id]) {
      expect(byId(id)).toMatchObject({
        name: expect.stringMatching(/^Bedienung \d+$/),
        short_name: null,
        color: null,
        is_active: false,
        anonymized_at: expect.any(Date),
      });
    }
    const pseudonym = byId(anna.id)!.name;
    expect(
      (await one(`SELECT actor_name FROM refunds WHERE order_id = $1`, [o]))
        .actor_name,
    ).toBe(pseudonym);
    expect(
      (
        await one(`SELECT actor_name FROM order_events WHERE order_id = $1`, [
          o,
        ])
      ).actor_name,
    ).toBe(pseudonym);
    // Steuerarchiv und Zuordnung bleiben.
    expect(
      (
        await one(
          `SELECT operator_name FROM tse_transactions WHERE waiter_id = $1`,
          [anna.id],
        )
      ).operator_name,
    ).toBe('Anna Berger');
    expect(
      (
        await one(
          `SELECT processed_by_waiter_id FROM payments WHERE order_id = $1`,
          [o],
        )
      ).processed_by_waiter_id,
    ).toBe(anna.id);
    expect(
      await sql(`SELECT * FROM pin_credentials WHERE owner_id = $1`, [anna.id]),
    ).toEqual([]);
    expect(
      await sql(`SELECT started_at FROM waiter_sessions WHERE waiter_id = $1`, [
        fresh.id,
      ]),
    ).toHaveLength(1);
  });

  it('keeps attribution when an event is deleted: servers are retired, not cascaded away', async () => {
    const w = await world();
    const bareEvent = async () =>
      (
        await one(
          `INSERT INTO events (organization_id, name, status) VALUES ($1, 'Kinderfest', 'inactive') RETURNING id`,
          [w.orgId],
        )
      ).id as string;

    // Papierkorb (Verwaltung): ohne Buchungen weg, sonst deaktiviert ohne PIN.
    const trashed = await bareEvent();
    const anna = await waiter(w, 'Anna Berger', { eventId: trashed });
    const nobody = await waiter(w, 'Ohne Buchung', { eventId: trashed });
    const o = await order(w, { creator: anna.id, total: 5, paid: 5 });
    await payment(o, { amount: 5, waiterId: anna.id });
    const retired = await ds.transaction((manager) =>
      retireEventWaiters(manager, w.orgId, trashed),
    );
    expect(retired).toMatchObject({ deleted: 1, deactivated: 1 });
    expect(
      await sql(`SELECT id FROM waiters WHERE id = $1`, [nobody.id]),
    ).toEqual([]);
    expect(
      await one(`SELECT is_active, deactivated_at FROM waiters WHERE id = $1`, [
        anna.id,
      ]),
    ).toMatchObject({ is_active: false, deactivated_at: expect.any(Date) });
    expect(
      await sql(`SELECT id FROM pin_credentials WHERE owner_id = $1`, [
        anna.id,
      ]),
    ).toEqual([]);

    // Wirklich geloescht (Datenbank): die Bedienung bleibt (deaktiviert,
    // ohne PIN), die Zuordnung der Zahlung auch.
    const gone = await bareEvent();
    const ben = await waiter(w, 'Ben Krause', { eventId: gone });
    const ob = await order(w, { creator: ben.id, total: 5, paid: 5 });
    const pb = await payment(ob, { amount: 5, waiterId: ben.id });
    await sql(`DELETE FROM events WHERE id = $1`, [gone]);
    expect(
      await one(
        `SELECT event_id, is_active, deactivated_at FROM waiters WHERE id = $1`,
        [ben.id],
      ),
    ).toMatchObject({
      event_id: null,
      is_active: false,
      deactivated_at: expect.any(Date),
    });
    expect(
      await sql(`SELECT id FROM pin_credentials WHERE owner_id = $1`, [ben.id]),
    ).toEqual([]);
    expect(
      (
        await one(`SELECT processed_by_waiter_id FROM payments WHERE id = $1`, [
          pb,
        ])
      ).processed_by_waiter_id,
    ).toBe(ben.id);
  });

  it('exports what is stored about a server (Art. 15) without the PIN', async () => {
    const w = await world();
    const anna = await waiter(w, 'Anna Berger');
    const lea = await waiter(w, 'Lea Schmidt', { role: 'lead' });
    const o = await order(w, { creator: anna.id, total: 5, paid: 5 });
    await payment(o, { amount: 5, waiterId: anna.id });
    await sessions.login(deviceRef(w), anna.pin);
    await settlements.settle(
      w.orgId,
      { kind: 'waiter', waiterId: anna.id },
      { userId: null, waiterId: lea.id, mayForce: true, deviceId: w.deviceA },
    );

    const data = await waiters.exportData(w.orgId, anna.id, w.admin);
    expect(data.waiter).toMatchObject({
      name: 'Anna Berger',
      hasPin: true,
      role: 'service',
    });
    expect(data.sessions).toEqual([
      expect.objectContaining({ device: 'Kasse Theke', endedAt: null }),
    ]);
    expect(data.settlements).toEqual([
      expect.objectContaining({ number: 1, cashExpected: 5, forced: false }),
    ]);
    expect(data.bookings).toMatchObject({
      ordersTaken: 1,
      ordersResponsible: 1,
      itemsSent: 1,
      paymentsProcessed: 1,
    });
    const csv = waiterExportCsv(data);
    expect(csv.startsWith('﻿Bereich;Feld;Wert\r\n')).toBe(true);
    expect(csv).toContain('Stammdaten;Name;Anna Berger');
    expect(csv).toContain('Abrechnung;Nr. 1;');
    expect(csv).toContain('Buchungen;Zahlungen kassiert;1');
    expect(csv).not.toContain(anna.pin);

    // Ohne Recht „Bedienungen“: kein Zugriff.
    const stranger = randomUUID();
    userIds.push(stranger);
    await sql(
      `INSERT INTO users (id, email, first_name, last_name) VALUES ($1, $2, 'Max', 'Muster')`,
      [stranger, `x-${stranger}@example.com`],
    );
    await sql(
      `INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1, $2, 'member')`,
      [stranger, w.orgId],
    );
    expect(
      await reasonOf(
        waiters.exportData(w.orgId, anna.id, { id: stranger } as User),
      ),
    ).toBe(ErrorReasons.INSUFFICIENT_PERMISSIONS);
  });
});
