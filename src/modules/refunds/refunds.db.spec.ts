import { randomUUID } from 'crypto';
import * as path from 'path';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { BadRequestException, Logger } from '@nestjs/common';
import {
  Device,
  Order,
  OrderEvent,
  OrderItem,
  Payment,
  Refund,
  UserOrganization,
} from '../../database/entities';
import { GatewayService } from '../gateway/gateway.service';
import { OrderPrintService } from '../print-jobs/order-print.service';
import { PrintJobsService } from '../print-jobs/print-jobs.service';
import { PrintRoutingService } from '../print-jobs/print-routing.service';
import { SumUpApiService } from '../sumup/sumup-api.service';
import {
  OrderHistoryService,
  applyHistoryFilters,
} from './order-history.service';
import {
  GOODWILL_NET,
  PAYMENT_REFUNDS,
  ReportsService,
} from '../reports/reports.service';
import { OrdersService } from '../orders/orders.service';
import type { QueryOrdersDto } from '../orders/dto';
import {
  Category,
  Event,
  Organization,
  PfandReturn,
  PrintJob,
  Product,
  StockMovement,
  PrintTemplate,
  Printer,
  ProductionStation,
  User,
} from '../../database/entities';
import { RefundsService, type RefundActor } from './refunds.service';

/**
 * Storno und Erstattung gegen ein echtes Postgres (Sperren, Transaktion,
 * Rueckrollen bei SumUp-Fehler, Summen und Gegenbelege).
 *
 * Laeuft nur mit einer Wegwerf-Datenbank, z. B.
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://openeos:openeos@127.0.0.1:5544/openeos_history_scratch pnpm test
 *
 * Name muss auf `_test` oder `_scratch` enden.
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

describeWithDb('RefundsService against Postgres', () => {
  let ds: DataSource;
  const orgIds: string[] = [];
  const gateway = {
    notifyOrderUpdated: jest.fn(),
    notifyOrderItemStatusChanged: jest.fn(),
    notifyKitchenOrderCancelled: jest.fn(),
    notifyProductUpdated: jest.fn(),
    sendOpenCashDrawer: jest.fn(),
  };
  const print = {
    printRefundReceipt: jest.fn(() => Promise.resolve(true)),
    printCancellationTickets: jest.fn(() => Promise.resolve()),
  };
  const sumup = { refundTransaction: jest.fn() };
  let service: RefundsService;
  let history: OrderHistoryService;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
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
    history = new OrderHistoryService(
      ds.getRepository(Order),
      ds.getRepository(OrderItem),
      ds.getRepository(Payment),
      ds.getRepository(Refund),
      ds.getRepository(OrderEvent),
    );
    service = new RefundsService(
      ds,
      ds.getRepository(UserOrganization),
      ds.getRepository(Refund),
      ds.getRepository(OrderEvent),
      ds.getRepository(Order),
      sumup as unknown as SumUpApiService,
      print as unknown as OrderPrintService,
      gateway as unknown as GatewayService,
      history,
    );
  }, 120_000);

  afterAll(async () => {
    if (ds?.isInitialized) {
      if (orgIds.length) {
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

  beforeEach(() => jest.clearAllMocks());

  async function q<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return await ds.query(sql, params);
  }

  interface World {
    orgId: string;
    eventId: string;
    deviceId: string;
    burgerId: string;
    pilsId: string;
    actor: RefundActor;
  }

  async function world(
    options: {
      eventStatus?: string;
      vatExempt?: boolean;
      sumup?: boolean;
    } = {},
  ): Promise<World> {
    const orgId = randomUUID();
    orgIds.push(orgId);
    const settings: Record<string, unknown> = {
      vatExempt: options.vatExempt ?? false,
    };
    if (options.sumup) {
      settings.sumup = { apiKey: 'sup_sk_test', merchantCode: 'MCODE' };
      settings.integrations = { sumup: { enabled: true } };
    }
    await q(
      `INSERT INTO organizations (id, name, slug, support_pin, settings)
       VALUES ($1, 'Verein', $2, '123456', $3)`,
      [orgId, `verein-${orgId}`, JSON.stringify(settings)],
    );
    const [event] = await q<{ id: string }>(
      `INSERT INTO events (organization_id, name, status)
       VALUES ($1, 'Fest', $2) RETURNING id`,
      [orgId, options.eventStatus ?? 'active'],
    );
    const [category] = await q<{ id: string }>(
      `INSERT INTO categories (event_id, name) VALUES ($1, 'Essen') RETURNING id`,
      [event.id],
    );
    const [burger] = await q<{ id: string }>(
      `INSERT INTO products (event_id, category_id, name, price, track_inventory, stock_quantity, tax_rate)
       VALUES ($1, $2, 'Burger', 10, true, 50, 19) RETURNING id`,
      [event.id, category.id],
    );
    const [pils] = await q<{ id: string }>(
      `INSERT INTO products (event_id, category_id, name, price, track_inventory, stock_quantity, tax_rate)
       VALUES ($1, $2, 'Pils', 4, true, 50, 19) RETURNING id`,
      [event.id, category.id],
    );
    const [device] = await q<{ id: string }>(
      `INSERT INTO devices (organization_id, name, type, device_token, settings)
       VALUES ($1, 'Kasse 1', 'pos', $2, '{}') RETURNING id`,
      [orgId, `tok-${randomUUID()}`],
    );
    return {
      orgId,
      eventId: event.id,
      deviceId: device.id,
      burgerId: burger.id,
      pilsId: pils.id,
      actor: {
        organizationId: orgId,
        deviceId: device.id,
        deviceName: 'Kasse 1',
        userId: null,
        actorName: null,
        cashDrawerPrinterId: 'drawer-1',
      },
    };
  }

  let daily = 0;
  /** 3x Burger (10) + 2x Pils (4, 2 Pfand), optional bezahlt. */
  async function order(
    w: World,
    options: {
      pay?: 'cash' | 'sumup_terminal' | 'card' | null;
      itemStatus?: string;
      discount?: number;
      tip?: number;
      createdAt?: Date;
      table?: string;
    } = {},
  ) {
    daily += 1;
    const discount = options.discount ?? 0;
    const tip = options.tip ?? 0;
    const total = 30 + 8 - discount + tip + 4;
    const pay = options.pay === undefined ? 'cash' : options.pay;
    const [o] = await q<{ id: string }>(
      `INSERT INTO orders (organization_id, event_id, order_number, daily_number,
         subtotal, discount_amount, tip_amount, pfand_total, total, paid_amount,
         payment_status, status, created_by_device_id, table_number, created_at)
       VALUES ($1, $2, $3, $4, 38, $5, $6, 4, $7, $8, $9, 'in_progress', $10, $11, $12)
       RETURNING id`,
      [
        w.orgId,
        w.eventId,
        `20261008-${String(daily).padStart(4, '0')}`,
        daily,
        discount,
        tip,
        total,
        pay ? total : 0,
        pay ? 'paid' : 'unpaid',
        w.deviceId,
        options.table ?? null,
        options.createdAt ?? new Date(),
      ],
    );
    const status = options.itemStatus ?? 'pending';
    const [burger] = await q<{ id: string }>(
      `INSERT INTO order_items (order_id, product_id, category_id, product_name, category_name,
         quantity, unit_price, tax_rate, total_price, status, paid_quantity, sort_order)
       SELECT $1, p.id, p.category_id, 'Burger', 'Essen', 3, 10, 19, 30, $2, $3, 0
       FROM products p WHERE p.id = $4 RETURNING id`,
      [o.id, status, pay ? 3 : 0, w.burgerId],
    );
    const [pils] = await q<{ id: string }>(
      `INSERT INTO order_items (order_id, product_id, category_id, product_name, category_name,
         quantity, unit_price, tax_rate, total_price, status, paid_quantity, deposit_amount, sort_order)
       SELECT $1, p.id, p.category_id, 'Pils', 'Essen', 2, 4, 19, 8, 'pending', $2, 2, 1
       FROM products p WHERE p.id = $3 RETURNING id`,
      [o.id, pay ? 2 : 0, w.pilsId],
    );
    await q(
      `UPDATE products SET stock_quantity = stock_quantity - 3 WHERE id = $1`,
      [w.burgerId],
    );
    await q(
      `UPDATE products SET stock_quantity = stock_quantity - 2 WHERE id = $1`,
      [w.pilsId],
    );
    let paymentId: string | null = null;
    if (pay) {
      const provider =
        pay === 'cash' ? 'CASH' : pay === 'card' ? 'CARD' : 'SUMUP';
      const [p] = await q<{ id: string }>(
        `INSERT INTO payments (order_id, amount, payment_method, payment_provider,
           provider_transaction_id, status, processed_by_device_id)
         VALUES ($1, $2, $3, $4, $5, 'captured', $6) RETURNING id`,
        [
          o.id,
          total,
          pay,
          provider,
          pay === 'sumup_terminal' ? 'client-txn-1' : null,
          w.deviceId,
        ],
      );
      paymentId = p.id;
    }
    return {
      orderId: o.id,
      burgerItemId: burger.id,
      pilsItemId: pils.id,
      paymentId,
      total,
    };
  }

  async function stock(productId: string): Promise<number> {
    const [row] = await q<{ s: number }>(
      `SELECT stock_quantity AS s FROM products WHERE id = $1`,
      [productId],
    );
    return Number(row.s);
  }

  function reason(error: unknown): string | undefined {
    return (
      (error as BadRequestException).getResponse?.() as { reason?: string }
    )?.reason;
  }

  it('cancels part of a pending position: split row, stock back, totals, station event, storno ticket', async () => {
    const w = await world();
    const o = await order(w, { pay: null });
    const before = await stock(w.burgerId);

    await service.cancelItems(w.actor, o.orderId, {
      items: [{ orderItemId: o.burgerItemId, quantity: 1 }],
      reasonCode: 'customer_request',
    });

    const items = await q<{
      quantity: number;
      status: string;
      total_price: string;
    }>(
      `SELECT quantity, status, total_price FROM order_items
       WHERE order_id = $1 AND product_name = 'Burger' ORDER BY status::text`,
      [o.orderId],
    );
    expect(items).toEqual([
      { quantity: 1, status: 'cancelled', total_price: '10.00' },
      { quantity: 2, status: 'pending', total_price: '20.00' },
    ]);
    expect(await stock(w.burgerId)).toBe(before + 1);
    const [ord] = await q<{ total: string; status: string }>(
      `SELECT total, status FROM orders WHERE id = $1`,
      [o.orderId],
    );
    expect(ord.total).toBe('32.00');
    expect(gateway.notifyOrderItemStatusChanged).toHaveBeenCalledWith(
      w.orgId,
      w.eventId,
      expect.objectContaining({ status: 'cancelled' }),
    );
    expect(print.printCancellationTickets).toHaveBeenCalled();
    const [event] = await q<{ type: string; device_id: string }>(
      `SELECT type, device_id FROM order_events WHERE order_id = $1`,
      [o.orderId],
    );
    expect(event).toEqual({ type: 'items_cancelled', device_id: w.deviceId });
  });

  it('asks for confirmation before cancelling a started position and keeps the stock', async () => {
    const w = await world();
    const o = await order(w, { pay: null, itemStatus: 'preparing' });
    const before = await stock(w.burgerId);

    await expect(
      service.cancelItems(w.actor, o.orderId, {
        items: [{ orderItemId: o.burgerItemId, quantity: 3 }],
      }),
    ).rejects.toMatchObject({
      response: { reason: 'ORDER_ITEM_ALREADY_STARTED' },
    });

    await service.cancelItems(w.actor, o.orderId, {
      items: [{ orderItemId: o.burgerItemId, quantity: 3 }],
      confirmStarted: true,
      reasonCode: 'quality',
    });
    expect(await stock(w.burgerId)).toBe(before);
  });

  it('refuses to cancel paid positions without a refund (atomic: nothing changes)', async () => {
    const w = await world();
    const o = await order(w);
    const before = await stock(w.burgerId);
    let thrown: unknown;
    try {
      await service.cancelItems(w.actor, o.orderId, {
        items: [{ orderItemId: o.burgerItemId, quantity: 1 }],
      });
    } catch (e) {
      thrown = e;
    }
    expect(reason(thrown)).toBe('ORDER_PAID_REFUND_REQUIRED');
    expect(await stock(w.burgerId)).toBe(before);
    const rows = await q(`SELECT 1 FROM order_items WHERE order_id = $1`, [
      o.orderId,
    ]);
    expect(rows).toHaveLength(2);
    await expect(
      service.cancelOrder(w.actor, o.orderId, {}),
    ).rejects.toMatchObject({
      response: { reason: 'ORDER_PAID_REFUND_REQUIRED' },
    });
  });

  it('cash refund of positions: counter-receipt with negative amounts, VAT per rate, drawer opens', async () => {
    const w = await world();
    const o = await order(w, { discount: 3.8 }); // 10 % Rabatt
    const outcome = await service.createRefund(w.actor, o.orderId, {
      mode: 'items',
      items: [{ orderItemId: o.pilsItemId, quantity: 1 }],
      reasonCode: 'quality',
      reasonText: 'schal',
    });
    const [refund] = outcome.refunds;
    // 4.00 * 0.9 = 3.60 + 2.00 Pfand
    expect(Number(refund.amount)).toBe(-5.6);
    expect(Number(refund.pfandAmount)).toBe(-2);
    expect(refund.taxLines).toEqual([
      { rate: 19, gross: -3.6, tax: -0.57, net: -3.03 },
    ]);
    expect(refund.kind).toBe('refund');
    expect(refund.status).toBe('completed');
    expect(refund.refundNumber).toMatch(/-E1$/);
    expect(gateway.sendOpenCashDrawer).toHaveBeenCalledWith(
      w.orgId,
      'drawer-1',
    );
    expect(print.printRefundReceipt).toHaveBeenCalledTimes(1);

    const detail = await history.detail(w.orgId, o.orderId);
    expect(detail.refundedAmount).toBe(5.6);
    expect(detail.displayStatus).toBe('partly_refunded');
    expect(
      detail.items.find((i) => i.id === o.pilsItemId)?.refundableQuantity,
    ).toBe(1);
    expect(detail.refunds[0].items).toEqual([
      expect.objectContaining({
        productName: 'Pils',
        quantity: 1,
        amount: -3.6,
        depositAmount: -2,
      }),
    ]);

    // Mehr als erstattbar geht nicht.
    await expect(
      service.createRefund(w.actor, o.orderId, {
        mode: 'amount',
        amount: 100,
        reasonCode: 'other',
      }),
    ).rejects.toMatchObject({
      response: { reason: 'REFUND_EXCEEDS_REFUNDABLE' },
    });
  });

  it('free amount refund and then the rest: fully refunded, payment marked refunded', async () => {
    const w = await world();
    const o = await order(w, { tip: 2 });
    await service.createRefund(w.actor, o.orderId, {
      mode: 'amount',
      amount: 5,
      reasonCode: 'price_error',
    });
    await service.createRefund(w.actor, o.orderId, {
      mode: 'full',
      reasonCode: 'customer_request',
    });
    const refunds = await q<{ amount: string; tip_amount: string }>(
      `SELECT amount, tip_amount FROM refunds WHERE order_id = $1 ORDER BY created_at`,
      [o.orderId],
    );
    expect(refunds.map((r) => Number(r.amount))).toEqual([-5, -(o.total - 5)]);
    expect(Number(refunds[1].tip_amount)).toBe(-2);
    const [ord] = await q<{ payment_status: string; refunded_amount: string }>(
      `SELECT payment_status, refunded_amount FROM orders WHERE id = $1`,
      [o.orderId],
    );
    expect(ord).toEqual({
      payment_status: 'refunded',
      refunded_amount: o.total.toFixed(2),
    });
    const [pay] = await q<{ status: string }>(
      `SELECT status FROM payments WHERE id = $1`,
      [o.paymentId],
    );
    expect(pay.status).toBe('refunded');
    await expect(
      service.createRefund(w.actor, o.orderId, {
        mode: 'full',
        reasonCode: 'other',
      }),
    ).rejects.toMatchObject({
      response: { reason: 'REFUND_NOTHING_TO_REFUND' },
    });
  });

  it('cancelling a paid order = full refund with cancellation (stock back for pending positions)', async () => {
    const w = await world();
    const o = await order(w);
    const before = await stock(w.burgerId);
    const outcome = await service.createRefund(w.actor, o.orderId, {
      mode: 'full',
      cancelItems: true,
      reasonCode: 'wrong_order',
    });
    expect(outcome.refunds[0].kind).toBe('cancellation');
    expect(Number(outcome.refunds[0].amount)).toBe(-o.total);
    expect(await stock(w.burgerId)).toBe(before + 3);
    const [ord] = await q<{ status: string; payment_status: string }>(
      `SELECT status, payment_status FROM orders WHERE id = $1`,
      [o.orderId],
    );
    expect(ord).toEqual({ status: 'cancelled', payment_status: 'refunded' });
    expect(gateway.notifyKitchenOrderCancelled).toHaveBeenCalled();
  });

  it('cancelling paid positions with refund reduces the order total and refunds the difference', async () => {
    const w = await world();
    const o = await order(w);
    const outcome = await service.createRefund(w.actor, o.orderId, {
      mode: 'items',
      cancelItems: true,
      items: [{ orderItemId: o.burgerItemId, quantity: 1 }],
      reasonCode: 'wrong_order',
    });
    expect(Number(outcome.refunds[0].amount)).toBe(-10);
    const [ord] = await q<{ total: string; status: string }>(
      `SELECT total, status FROM orders WHERE id = $1`,
      [o.orderId],
    );
    expect(ord.total).toBe((o.total - 10).toFixed(2));
    expect(ord.status).not.toBe('cancelled');
  });

  it('refunds a SumUp payment through the SumUp API', async () => {
    const w = await world({ sumup: true });
    const o = await order(w, { pay: 'sumup_terminal' });
    sumup.refundTransaction.mockResolvedValueOnce({
      transactionId: 'txn-77',
      transactionCode: 'TC',
    });
    const outcome = await service.createRefund(w.actor, o.orderId, {
      mode: 'amount',
      amount: 4,
      reasonCode: 'quality',
    });
    expect(sumup.refundTransaction).toHaveBeenCalledWith(
      'sup_sk_test',
      'MCODE',
      'client-txn-1',
      4,
    );
    expect(outcome.refunds[0]).toMatchObject({
      status: 'completed',
      providerReference: 'txn-77',
      paymentMethod: 'sumup_terminal',
    });
    expect(gateway.sendOpenCashDrawer).not.toHaveBeenCalled();
  });

  it('rolls back when SumUp refuses, logs the attempt, and allows "manually refunded"', async () => {
    const w = await world({ sumup: true });
    const o = await order(w, { pay: 'sumup_terminal' });
    sumup.refundTransaction.mockRejectedValueOnce(
      new BadRequestException({
        code: 'SUMUP_API_ERROR',
        message: 'INVALID_AMOUNT',
        errorType: 'INVALID_AMOUNT',
        details: [
          {
            code: 'SUMUP_HTTP_422',
            message: 'Amount exceeds the refundable amount',
          },
        ],
      }),
    );
    await expect(
      service.createRefund(w.actor, o.orderId, {
        mode: 'full',
        cancelItems: true,
        reasonCode: 'quality',
      }),
    ).rejects.toMatchObject({
      response: {
        reason: 'REFUND_PROVIDER_FAILED',
        params: { providerError: 'INVALID_AMOUNT' },
      },
    });
    // Nichts gebucht, nichts storniert.
    expect(
      await q(`SELECT 1 FROM refunds WHERE order_id = $1`, [o.orderId]),
    ).toHaveLength(0);
    const [ord] = await q<{ status: string; refunded_amount: string }>(
      `SELECT status, refunded_amount FROM orders WHERE id = $1`,
      [o.orderId],
    );
    expect(ord).toEqual({ status: 'in_progress', refunded_amount: '0.00' });
    const events = await q<{ type: string }>(
      `SELECT type FROM order_events WHERE order_id = $1`,
      [o.orderId],
    );
    expect(events.map((e) => e.type)).toEqual(['refund_failed']);

    const manual = await service.createRefund(w.actor, o.orderId, {
      mode: 'full',
      cancelItems: true,
      reasonCode: 'quality',
      manual: true,
    });
    expect(manual.refunds[0].status).toBe('manual');
    expect(sumup.refundTransaction).toHaveBeenCalledTimes(1);
  });

  it('does not refund at SumUp in test mode', async () => {
    const w = await world({ sumup: true, eventStatus: 'test' });
    const o = await order(w, { pay: 'sumup_terminal' });
    const outcome = await service.createRefund(w.actor, o.orderId, {
      mode: 'amount',
      amount: 2,
      reasonCode: 'other',
    });
    expect(sumup.refundTransaction).not.toHaveBeenCalled();
    expect(outcome.refunds[0]).toMatchObject({ status: 'test', isTest: true });
  });

  it('books external card refunds as manual', async () => {
    const w = await world();
    const o = await order(w, { pay: 'card' });
    const outcome = await service.createRefund(w.actor, o.orderId, {
      mode: 'amount',
      amount: 2,
      reasonCode: 'other',
    });
    expect(outcome.refunds[0].status).toBe('manual');
  });

  it('is idempotent with clientRequestId', async () => {
    const w = await world();
    const o = await order(w);
    const clientRequestId = randomUUID();
    const first = await service.createRefund(w.actor, o.orderId, {
      mode: 'amount',
      amount: 1,
      reasonCode: 'other',
      clientRequestId,
    });
    const second = await service.createRefund(w.actor, o.orderId, {
      mode: 'amount',
      amount: 1,
      reasonCode: 'other',
      clientRequestId,
    });
    expect(second.refunds[0].id).toBe(first.refunds[0].id);
    expect(
      await q(`SELECT 1 FROM refunds WHERE order_id = $1`, [o.orderId]),
    ).toHaveLength(1);
  });

  it('serialises concurrent refunds (row lock): never more than was paid', async () => {
    const w = await world();
    const o = await order(w);
    const results = await Promise.allSettled([
      service.createRefund(w.actor, o.orderId, {
        mode: 'full',
        reasonCode: 'other',
      }),
      service.createRefund(w.actor, o.orderId, {
        mode: 'full',
        reasonCode: 'other',
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [sum] = await q<{ s: string }>(
      `SELECT SUM(amount) AS s FROM refunds WHERE order_id = $1`,
      [o.orderId],
    );
    expect(Number(sum.s)).toBe(-o.total);
  });

  it('device permission "pin": requires a PIN of a member with the orders right', async () => {
    const w = await world();
    const userId = randomUUID();
    await q(
      `INSERT INTO users (id, email, first_name, last_name) VALUES ($1, $2, 'Lena', 'Kasse')`,
      [userId, `u-${userId}@example.com`],
    );
    const otherId = randomUUID();
    await q(
      `INSERT INTO users (id, email, first_name, last_name) VALUES ($1, $2, 'Tom', 'Helfer')`,
      [otherId, `u-${otherId}@example.com`],
    );
    await q(
      `INSERT INTO user_organizations (user_id, organization_id, role, permissions, pin)
       VALUES ($1, $3, 'member', '{"orders": true}', $4),
              ($2, $3, 'member', '{}', $5)`,
      [
        userId,
        otherId,
        w.orgId,
        await bcrypt.hash('4711', 4),
        await bcrypt.hash('1234', 4),
      ],
    );
    const device = {
      id: w.deviceId,
      name: 'Kasse 1',
      organizationId: w.orgId,
      settings: { refundPermission: 'pin' },
    } as unknown as Device;

    await expect(service.resolveDeviceActor(device, {})).rejects.toMatchObject({
      response: { reason: 'REFUND_PIN_REQUIRED' },
    });
    await expect(
      service.resolveDeviceActor(device, { pin: '1234' }),
    ).rejects.toMatchObject({
      response: { reason: 'REFUND_PIN_NOT_AUTHORIZED' },
    });
    await expect(
      service.resolveDeviceActor(device, { pin: '9999' }),
    ).rejects.toMatchObject({ response: { reason: 'PIN_INVALID' } });
    const actor = await service.resolveDeviceActor(device, { pin: '4711' });
    expect(actor).toMatchObject({ userId, actorName: 'Lena Kasse' });

    await expect(
      service.resolveDeviceActor(
        { ...device, settings: { refundPermission: 'disabled' } } as Device,
        { pin: '4711' },
      ),
    ).rejects.toMatchObject({ response: { reason: 'REFUND_NOT_ALLOWED' } });

    const o = await order(w);
    await service.createRefund(actor, o.orderId, {
      mode: 'amount',
      amount: 1,
      reasonCode: 'other',
    });
    const [refund] = await q<{ user_id: string; actor_name: string }>(
      `SELECT user_id, actor_name FROM refunds WHERE order_id = $1`,
      [o.orderId],
    );
    expect(refund).toEqual({ user_id: userId, actor_name: 'Lena Kasse' });
  });

  describe('history list', () => {
    it('filters server-side, counts per status and pages with a cursor', async () => {
      const w = await world();
      const a = await order(w, { pay: null, table: 'A06' });
      const b = await order(w);
      const c = await order(w);
      await service.createRefund(w.actor, c.orderId, {
        mode: 'amount',
        amount: 1,
        reasonCode: 'other',
      });
      const all = await history.list(
        w.orgId,
        { eventId: w.eventId },
        { limit: 2 },
      );
      expect(all.meta.counts).toMatchObject({
        all: 3,
        unpaid: 1,
        in_kitchen: 1,
        partly_refunded: 1,
      });
      expect(all.data).toHaveLength(2);
      expect(all.meta.nextCursor).toBeTruthy();
      const next = await history.list(
        w.orgId,
        { eventId: w.eventId },
        { limit: 2, cursor: all.meta.nextCursor },
      );
      expect(next.data.map((r) => r.id)).toEqual([a.orderId]);
      expect(next.meta.nextCursor).toBeNull();

      const unpaid = await history.list(
        w.orgId,
        { eventId: w.eventId, displayStatuses: ['unpaid'] },
        {},
      );
      expect(unpaid.data.map((r) => r.id)).toEqual([a.orderId]);
      expect(unpaid.data[0].items.map((i) => i.productName)).toEqual([
        'Burger',
        'Pils',
      ]);

      const byTable = await history.list(
        w.orgId,
        { eventId: w.eventId, q: 'a06' },
        {},
      );
      expect(byTable.data.map((r) => r.id)).toEqual([a.orderId]);
      const byNumber = await history.list(
        w.orgId,
        { eventId: w.eventId, q: `#${daily - 1}` },
        {},
      );
      expect(byNumber.data.map((r) => r.id)).toEqual([b.orderId]);
      const byProduct = await history.list(
        w.orgId,
        { eventId: w.eventId, q: 'pil' },
        {},
      );
      expect(byProduct.meta.total).toBe(3);
      const cash = await history.list(
        w.orgId,
        { eventId: w.eventId, paymentMethods: ['cash'] },
        {},
      );
      expect(cash.data.map((r) => r.id).sort()).toEqual(
        [b.orderId, c.orderId].sort(),
      );
      expect(cash.data[0].paymentMethods).toEqual(['cash']);
      const mine = await history.list(
        w.orgId,
        { eventId: w.eventId, deviceId: randomUUID() },
        {},
      );
      expect(mine.meta.counts.all).toBe(0);
    });
  });

  it('report SQL: net revenue subtracts goodwill refunds only, payments subtract all refunds', async () => {
    const w = await world();
    const a = await order(w); // 42
    const b = await order(w); // 42
    await service.createRefund(w.actor, a.orderId, {
      mode: 'amount',
      amount: 5,
      reasonCode: 'other',
    });
    await service.createRefund(w.actor, b.orderId, {
      mode: 'items',
      cancelItems: true,
      items: [{ orderItemId: b.burgerItemId, quantity: 1 }],
      reasonCode: 'wrong_order',
    });
    const revenue = await ds
      .getRepository(Order)
      .createQueryBuilder('order')
      .select(
        `SUM(order.total - order.pfandTotal + ${GOODWILL_NET})`,
        'revenue',
      )
      .where('order.organizationId = :orgId', { orgId: w.orgId })
      .andWhere('order.status != :c', { c: 'cancelled' })
      .getRawOne<{ revenue: string }>();
    // (38 - 5) + (28) = 61 Umsatz ohne Pfand
    expect(Number(revenue?.revenue)).toBe(61);
    const money = await ds
      .getRepository(Payment)
      .createQueryBuilder('payment')
      .innerJoin('payment.order', 'order')
      .select(`SUM(payment.amount + ${PAYMENT_REFUNDS})`, 'total')
      .where('order.organizationId = :orgId', { orgId: w.orgId })
      .getRawOne<{ total: string }>();
    expect(Number(money?.total)).toBe(84 - 5 - 10);

    const filtered = ds
      .getRepository(Order)
      .createQueryBuilder('ord')
      .where('ord.organizationId = :orgId', { orgId: w.orgId });
    applyHistoryFilters(filtered, 'ord', {
      q: 'Burger',
      paymentMethods: ['cash'],
      displayStatuses: ['partly_refunded'],
    });
    expect((await filtered.getMany()).map((o) => o.id).sort()).toEqual(
      [a.orderId, b.orderId].sort(),
    );
  });

  it('product and category reports are net and add up to the net revenue', async () => {
    const w = await world();
    const userId = randomUUID();
    await q(
      `INSERT INTO users (id, email, first_name, last_name) VALUES ($1, $2, 'Rita', 'Report')`,
      [userId, `r-${userId}@example.com`],
    );
    await q(
      `INSERT INTO user_organizations (user_id, organization_id, role, permissions)
       VALUES ($1, $2, 'admin', '{}')`,
      [userId, w.orgId],
    );
    // Jede Bestellung: 3x Burger (10) + 2x Pils (4, Pfand 2) = 38 Ware.
    // A: Verkauf ohne alles.
    await order(w);
    // B: Teilerstattung nach Position (1 Burger, Kulanz ohne Storno).
    const b = await order(w);
    await service.createRefund(w.actor, b.orderId, {
      mode: 'items',
      items: [{ orderItemId: b.burgerItemId, quantity: 1 }],
      reasonCode: 'quality',
    });
    // C: Storno einer bezahlten Position mit Erstattung (1 Pils + Pfand).
    const c = await order(w);
    await service.createRefund(w.actor, c.orderId, {
      mode: 'items',
      cancelItems: true,
      items: [{ orderItemId: c.pilsItemId, quantity: 1 }],
      reasonCode: 'wrong_order',
    });
    // D: Kulanz ohne Positionsbezug (freier Betrag).
    const d = await order(w);
    await service.createRefund(w.actor, d.orderId, {
      mode: 'amount',
      amount: 5,
      reasonCode: 'customer_request',
    });
    // E: 10 % Rabatt (3,80), 2 € Trinkgeld, 1 Burger erstattet (9,00).
    const e = await order(w, { discount: 3.8, tip: 2 });
    await service.createRefund(w.actor, e.orderId, {
      mode: 'items',
      items: [{ orderItemId: e.burgerItemId, quantity: 1 }],
      reasonCode: 'quality',
    });
    // F: unbezahlt, 1 Burger storniert (ohne Erstattung).
    const f = await order(w, { pay: null });
    await service.cancelItems(w.actor, f.orderId, {
      items: [{ orderItemId: f.burgerItemId, quantity: 1 }],
      reasonCode: 'customer_request',
    });
    // H: erst 5 € Kulanz, dann der Rest komplett erstattet — Produkte
    // stehen bei 0, die 5 € zaehlen nicht doppelt.
    const h = await order(w);
    await service.createRefund(w.actor, h.orderId, {
      mode: 'amount',
      amount: 5,
      reasonCode: 'other',
    });
    await service.createRefund(w.actor, h.orderId, {
      mode: 'full',
      reasonCode: 'other',
    });
    // G: ganz storniert — zaehlt nirgends.
    const g = await order(w, { pay: null });
    await service.cancelOrder(w.actor, g.orderId, {});

    const reports = new ReportsService(
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
      { get: () => undefined } as never,
    );
    const user = { id: userId } as User;
    const query = { eventId: w.eventId };

    const products = await reports.getProductsReport(w.orgId, query, user);
    const byName = Object.fromEntries(products.map((p) => [p.productName, p]));
    // Burger: 3 + 2 + 3 + 3 + 2 (je 9 nach Rabatt) + 2 = 15 Stueck
    expect(byName.Burger.quantitySold).toBe(15);
    expect(byName.Burger.revenue).toBe(30 + 20 + 30 + 30 + 18 + 20);
    // Pils: 2 + 2 + 1 (Storno) + 2 + 2 (je 3,60) + 2 = 11 Stueck
    expect(byName.Pils.quantitySold).toBe(11);
    expect(byName.Pils.revenue).toBe(43.2);

    const categories = await reports.getCategoriesReport(w.orgId, query, user);
    expect(categories).toEqual([
      expect.objectContaining({ name: 'Essen', quantity: 26, revenue: 191.2 }),
    ]);

    const summary = await reports.getNetSalesSummary(w.orgId, query, user);
    expect(summary).toEqual({
      itemsRevenue: 191.2,
      unassignedRefunds: -5,
      tips: 2,
      netRevenue: 188.2,
    });

    // Konsistenz: Produkte + Erstattungen ohne Position + Trinkgeld =
    // Umsatz netto des Verkaufsberichts.
    const sales = await reports.getSalesReport(w.orgId, query, user);
    expect(sales.totalRevenue).toBe(188.2);
    expect(sales.totalItemsSold).toBe(26);
    const productSum = products.reduce((sum, p) => sum + p.revenue, 0);
    expect(
      Math.round(
        (productSum + summary.unassignedRefunds + summary.tips) * 100,
      ) / 100,
    ).toBe(sales.totalRevenue);
  });

  it('admin list and stats: one status per order, net revenue', async () => {
    const w = await world();
    const userId = randomUUID();
    await q(
      `INSERT INTO users (id, email, first_name, last_name) VALUES ($1, $2, 'Ada', 'Admin')`,
      [userId, `a-${userId}@example.com`],
    );
    await q(
      `INSERT INTO user_organizations (user_id, organization_id, role, permissions)
       VALUES ($1, $2, 'admin', '{}')`,
      [userId, w.orgId],
    );
    const a = await order(w);
    await order(w, { pay: null });
    await service.createRefund(w.actor, a.orderId, {
      mode: 'amount',
      amount: 2,
      reasonCode: 'other',
    });
    const none = undefined as never;
    const orders = new OrdersService(
      ds.getRepository(Order),
      ds.getRepository(OrderItem),
      none,
      none,
      ds.getRepository(UserOrganization),
      none,
      none,
      none,
      none,
      none,
      none,
      none,
    );
    const user = { id: userId } as User;
    const list = await orders.findAll(w.orgId, user, {
      eventId: w.eventId,
      displayStatus: 'partly_refunded',
    } as QueryOrdersDto);
    expect(list.data.map((o) => o.id)).toEqual([a.orderId]);
    expect(
      (list.data[0] as Order & { displayStatus: string }).displayStatus,
    ).toBe('partly_refunded');
    expect(
      (list.data[0] as Order & { paymentMethods: string[] }).paymentMethods,
    ).toEqual(['cash']);
    const stats = await orders.getStats(w.orgId, user, {
      eventId: w.eventId,
    } as QueryOrdersDto);
    // 2 x 42 brutto inkl. Pfand, minus 2 Kulanz
    expect(stats.revenue).toBe(82);
    expect(stats.count).toBe(2);
  });

  it('prints the counter-receipt and the kitchen storno ticket as print jobs', async () => {
    const w = await world();
    const [printer] = await q<{ id: string }>(
      `INSERT INTO printers (organization_id, name, type, connection_type, device_id, is_active)
       VALUES ($1, 'Bon', 'receipt', 'network', $2, true) RETURNING id`,
      [w.orgId, w.deviceId],
    );
    await q(
      `UPDATE devices SET settings = jsonb_build_object('defaultPrinterId', $2::text) WHERE id = $1`,
      [w.deviceId, printer.id],
    );
    const agent = {
      sendPrintJobToAgent: jest.fn(() => Promise.resolve(false)),
    };
    const printJobs = new PrintJobsService(
      ds.getRepository(PrintJob),
      ds.getRepository(Printer),
      ds.getRepository(PrintTemplate),
      ds.getRepository(UserOrganization),
      agent as unknown as GatewayService,
    );
    const routing = new PrintRoutingService(
      ds.getRepository(Device),
      ds.getRepository(ProductionStation),
      ds.getRepository(Organization),
      ds.getRepository(OrderItem),
    );
    const realPrint = new OrderPrintService(
      ds.getRepository(Organization),
      ds.getRepository(OrderItem),
      ds.getRepository(Device),
      ds.getRepository(Event),
      printJobs,
      routing,
    );
    const printing = new RefundsService(
      ds,
      ds.getRepository(UserOrganization),
      ds.getRepository(Refund),
      ds.getRepository(OrderEvent),
      ds.getRepository(Order),
      sumup as unknown as SumUpApiService,
      realPrint,
      gateway as unknown as GatewayService,
      history,
    );
    const o = await order(w);
    const outcome = await printing.createRefund(w.actor, o.orderId, {
      mode: 'items',
      cancelItems: true,
      items: [{ orderItemId: o.burgerItemId, quantity: 1 }],
      reasonCode: 'wrong_order',
    });
    expect((outcome.refunds[0] as Refund & { printed?: boolean }).printed).toBe(
      true,
    );
    // Storno-Bon geht asynchron raus.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const jobs = await q<{ data: Record<string, unknown> }>(
      `SELECT payload->'data' AS data FROM print_jobs WHERE order_id = $1 ORDER BY created_at`,
      [o.orderId],
    );
    const sent = agent.sendPrintJobToAgent.mock.calls.map(
      (call) =>
        (call as unknown as [string, string, { templateName: string }])[2]
          .templateName,
    );
    expect(sent.sort()).toEqual(['cancellation_ticket', 'refund_receipt']);
    const receipt = jobs.find((j) => j.data.refund_number)!.data;
    expect(receipt).toMatchObject({
      refund_kind: 'cancellation',
      total: -10,
      payment_label: 'Bar',
      reason: 'Falsch bestellt',
      items: [{ quantity: 1, name: 'Burger', total: -10 }],
      tax_lines: [{ rate: 19, gross: -10, tax: -1.6, net: -8.4 }],
    });
    expect(typeof receipt.order_number).toBe('string');
    const ticket = jobs.find((j) => !j.data.refund_number)!.data;
    expect(ticket).toMatchObject({
      items: [{ quantity: 1, name: 'Burger', options: [] }],
      reason: 'Falsch bestellt',
    });
  });
});
