import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { FindOperator } from 'typeorm';
import {
  OrderItem,
  OrderItemStatus,
} from '../../database/entities/order-item.entity';
import {
  Order,
  OrderStatus,
  PaymentStatus,
} from '../../database/entities/order.entity';
import { Organization } from '../../database/entities/organization.entity';
import { Event, EventStatus } from '../../database/entities/event.entity';
import {
  Payment,
  PaymentMethod,
  PaymentProvider,
} from '../../database/entities/payment.entity';
import { BatchPaymentDto } from './dto/batch-payment.dto';
import {
  PaymentsBatchService,
  amountReceivedFor,
  distributeDiscount,
} from './payments-batch.service';

const ORG = 'org-1';

type Row = Record<string, unknown> & { id: string };

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

function matches(value: unknown, condition: unknown): boolean {
  if (condition instanceof FindOperator) {
    if (condition.type !== 'in') throw new Error('operator not faked');
    return (condition.value as unknown as unknown[]).includes(value);
  }
  return value === condition;
}

/** Bestellungen, Positionen, Zahlungen im Speicher; Transaktion mit Rollback. */
class FakeDb {
  orders: Row[] = [];
  items: Row[] = [];
  payments: Row[] = [];
  events: Row[] = [{ id: 'event-1', status: EventStatus.ACTIVE }];
  organization: Row = { id: ORG, settings: { vatExempt: false } };
  locks: unknown[] = [];
  private seq = 0;

  rowsOf(entity: unknown): Row[] {
    if (entity === Order) return this.orders;
    if (entity === OrderItem) return this.items;
    if (entity === Payment) return this.payments;
    if (entity === Event) return this.events;
    throw new Error('unexpected entity');
  }

  private filter(entity: unknown, where: Record<string, unknown> = {}) {
    return this.rowsOf(entity).filter((row) =>
      Object.entries(where).every(([k, v]) => matches(row[k], v)),
    );
  }

  manager() {
    const clone = (row: Row) => ({ ...row });
    return {
      findOne: (entity: unknown) =>
        Promise.resolve(entity === Organization ? this.organization : null),
      find: (
        entity: unknown,
        opts: {
          where?: Record<string, unknown>;
          lock?: unknown;
          relations?: string[];
        },
      ) => {
        if (opts.lock) this.locks.push(opts.lock);
        return Promise.resolve(
          this.filter(entity, opts.where).map((row) =>
            opts.relations?.includes('items')
              ? {
                  ...row,
                  items: this.items
                    .filter((i) => i.orderId === row.id)
                    .map(clone),
                }
              : clone(row),
          ),
        );
      },
      create: (_entity: unknown, data: Record<string, unknown>) => ({
        ...data,
      }),
      save: (input: Row | Row[]) => {
        const list = Array.isArray(input) ? input : [input];
        for (const row of list) {
          const entity =
            'amount' in row && 'paymentMethod' in row
              ? Payment
              : 'productName' in row
                ? OrderItem
                : Order;
          const rows = this.rowsOf(entity);
          if (!row.id) row.id = `pay-${++this.seq}`;
          const index = rows.findIndex((r) => r.id === row.id);
          if (index >= 0) rows[index] = { ...row };
          else rows.push({ ...row });
        }
        return Promise.resolve(input);
      },
    };
  }

  dataSource() {
    return {
      transaction: async (work: (m: unknown) => Promise<unknown>) => {
        const snapshot = JSON.stringify([
          this.orders,
          this.items,
          this.payments,
        ]);
        try {
          return await work(this.manager());
        } catch (error) {
          [this.orders, this.items, this.payments] = JSON.parse(
            snapshot,
          ) as Row[][];
          throw error;
        }
      },
    };
  }
}

function order(id: string, extra: Partial<Order> = {}): Row {
  return {
    id,
    organizationId: ORG,
    eventId: 'event-1',
    orderNumber: `N-${id}`,
    status: OrderStatus.OPEN,
    paymentStatus: PaymentStatus.UNPAID,
    subtotal: 10,
    discountAmount: 0,
    discountReason: null,
    tipAmount: 0,
    pfandTotal: 0,
    total: 10,
    paidAmount: 0,
    taxTotal: 0,
    ...extra,
  } as unknown as Row;
}

function item(id: string, orderId: string, extra: Partial<OrderItem> = {}) {
  return {
    id,
    orderId,
    productName: `P-${id}`,
    quantity: 1,
    paidQuantity: 0,
    totalPrice: 10,
    taxRate: 19,
    depositAmount: 0,
    status: OrderItemStatus.PENDING,
    productionStationId: null,
    ...extra,
  } as unknown as Row;
}

function setup() {
  const db = new FakeDb();
  const gateway = {
    notifyPaymentReceived: jest.fn(),
    notifyOrderUpdated: jest.fn(),
  };
  const print = { handlePaymentReceived: jest.fn(() => Promise.resolve()) };
  const service = new PaymentsBatchService(
    db.dataSource() as never,
    gateway as never,
    print as never,
  );
  const pay = (dto: Partial<BatchPaymentDto>) =>
    service.payBatch(ORG, 'device-1', {
      paymentMethod: PaymentMethod.CASH,
      ...dto,
    } as BatchPaymentDto);
  return { db, gateway, print, pay };
}

const byId = (rows: Row[], id: string) => rows.find((r) => r.id === id)!;

describe('amountReceivedFor / distributeDiscount', () => {
  it('only the last payment carries the received cash, minus the others', () => {
    expect(amountReceivedFor(0, [12.5, 7.3], 50)).toBeUndefined();
    expect(amountReceivedFor(1, [12.5, 7.3], 50)).toBe(37.5);
    expect(amountReceivedFor(1, [12.5, 7.3], undefined)).toBeUndefined();
  });

  it('spreads a discount from the last position backwards, capped', () => {
    expect(distributeDiscount([10, 10, 3], 5)).toEqual([0, 2, 3]);
    expect(distributeDiscount([10, 1], 20)).toEqual([10, 1]);
    expect(distributeDiscount([0.1, 0.2], 0.3)).toEqual([0.1, 0.2]);
  });
});

describe('PaymentsBatchService.payBatch', () => {
  it('pays every order with its remaining amount in one go', async () => {
    const { db, pay, gateway, print } = setup();
    db.orders.push(
      order('o1', { total: 12.5 }),
      order('o2', {
        total: 10,
        paidAmount: 2.7,
        paymentStatus: PaymentStatus.PARTLY_PAID,
      }),
    );
    db.items.push(item('i1', 'o1'), item('i2', 'o2', { quantity: 2 }));

    const result = await pay({ orderIds: ['o1', 'o2'], amountReceived: 50 });

    expect(result.totalPaid).toBe(19.8);
    expect(result.change).toBe(30.2);
    expect(db.payments.map((p) => [p.orderId, p.amount])).toEqual([
      ['o1', 12.5],
      ['o2', 7.3],
    ]);
    // Rueckgeld nur auf dem Bon der letzten Zahlung.
    expect(db.payments[0].metadata).not.toHaveProperty('amountReceived');
    expect(db.payments[1].metadata).toMatchObject({ amountReceived: 37.5 });
    expect(new Set(db.payments.map((p) => p.processedByDeviceId))).toEqual(
      new Set(['device-1']),
    );
    expect(db.payments[0].paymentProvider).toBe(PaymentProvider.CASH);

    for (const id of ['o1', 'o2']) {
      expect(byId(db.orders, id)).toMatchObject({
        paymentStatus: PaymentStatus.PAID,
        status: OrderStatus.COMPLETED,
      });
    }
    expect(byId(db.items, 'i2').paidQuantity).toBe(2);
    expect(db.locks).toEqual([{ mode: 'pessimistic_write' }]);

    expect(gateway.notifyPaymentReceived).toHaveBeenCalledTimes(2);
    expect(gateway.notifyPaymentReceived).toHaveBeenCalledWith(
      ORG,
      'event-1',
      expect.objectContaining({
        orderId: 'o2',
        amount: 7.3,
        paymentStatus: PaymentStatus.PAID,
      }),
    );
    expect(print.handlePaymentReceived).toHaveBeenCalledTimes(2);
    expect(result.orders.map((o) => o.id)).toEqual(['o1', 'o2']);
  });

  it('is atomic: an already paid order rolls everything back (409)', async () => {
    const { db, pay, gateway } = setup();
    db.orders.push(
      order('o1'),
      order('o2', { paymentStatus: PaymentStatus.PAID, paidAmount: 10 }),
    );
    db.items.push(item('i1', 'o1'));

    const call = pay({ orderIds: ['o1', 'o2'], tipAmount: 2 });
    await expect(call).rejects.toBeInstanceOf(ConflictException);
    await expect(call).rejects.toMatchObject({
      response: { code: 'ORDER_ALREADY_PAID', reason: 'ORDER_ALREADY_PAID' },
    });
    expect(db.payments).toHaveLength(0);
    expect(byId(db.orders, 'o1')).toMatchObject({
      paymentStatus: PaymentStatus.UNPAID,
      paidAmount: 0,
      total: 10,
    });
    expect(gateway.notifyPaymentReceived).not.toHaveBeenCalled();
  });

  it('rejects unknown or foreign orders (404) and cancelled ones (400)', async () => {
    const { db, pay } = setup();
    db.orders.push(
      order('o1'),
      order('foreign', { organizationId: 'org-2' } as Partial<Order>),
      order('gone', { status: OrderStatus.CANCELLED }),
    );

    await expect(pay({ orderIds: ['o1', 'foreign'] })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(pay({ orderIds: ['o1', 'gone'] })).rejects.toMatchObject({
      response: { reason: 'ORDER_ALREADY_CANCELLED' },
    });
    expect(db.payments).toHaveLength(0);
  });

  it('rejects less cash than due', async () => {
    const { db, pay } = setup();
    db.orders.push(order('o1'), order('o2'));
    const call = pay({ orderIds: ['o1', 'o2'], amountReceived: 19.99 });
    await expect(call).rejects.toBeInstanceOf(BadRequestException);
    await expect(call).rejects.toMatchObject({
      response: { reason: 'PAYMENT_AMOUNT_MISMATCH' },
    });
  });

  it('books the tip on the last order', async () => {
    const { db, pay, gateway } = setup();
    db.orders.push(order('o1'), order('o2'));

    const result = await pay({
      orderIds: ['o1', 'o2'],
      paymentMethod: PaymentMethod.CARD,
      tipAmount: 2,
    });

    expect(byId(db.orders, 'o2')).toMatchObject({ tipAmount: 2, total: 12 });
    expect(byId(db.orders, 'o1')).toMatchObject({ tipAmount: 0, total: 10 });
    expect(result.totalPaid).toBe(22);
    expect(result.change).toBe(0);
    expect(gateway.notifyOrderUpdated).toHaveBeenCalledWith(
      ORG,
      'event-1',
      'o2',
      expect.objectContaining({ tipAmount: 2, total: 12 }),
    );
  });

  it('spreads a discount from the last order backwards, capped at the open amount without Pfand', async () => {
    const { db, pay, gateway } = setup();
    db.orders.push(
      order('o1', { subtotal: 10, total: 10 }),
      // 6 € Ware + 2 € Pfand, schon 1 € bezahlt → offen 7, rabattfaehig 6.
      order('o2', {
        subtotal: 6,
        pfandTotal: 2,
        total: 8,
        paidAmount: 1,
        paymentStatus: PaymentStatus.PARTLY_PAID,
      }),
    );
    db.items.push(
      item('i1', 'o1'),
      item('i2', 'o2', { totalPrice: 6, depositAmount: 2 }),
    );

    const result = await pay({
      orderIds: ['o1', 'o2'],
      discountAmount: 8,
      discountReason: 'Freigetränk',
    });

    expect(byId(db.orders, 'o2')).toMatchObject({
      discountAmount: 6,
      total: 2,
      discountReason: 'Freigetränk',
      paymentStatus: PaymentStatus.PAID,
    });
    expect(byId(db.orders, 'o1')).toMatchObject({
      discountAmount: 2,
      total: 8,
    });
    expect(Number(byId(db.orders, 'o1').taxTotal)).toBeGreaterThan(0);
    expect(db.payments.map((p) => [p.orderId, p.amount])).toEqual([
      ['o1', 8],
      ['o2', 1],
    ]);
    expect(result.totalPaid).toBe(9);
    expect(gateway.notifyOrderUpdated).toHaveBeenCalledWith(
      ORG,
      'event-1',
      'o1',
      expect.objectContaining({ discountAmount: 2, total: 8 }),
    );
  });

  it('settles orders without a payment when the discount covers them', async () => {
    const { db, pay, gateway } = setup();
    db.orders.push(order('o1', { subtotal: 4, total: 4 }));
    db.items.push(item('i1', 'o1', { totalPrice: 4 }));

    const result = await pay({ orderIds: ['o1'], discountAmount: 10 });

    expect(db.payments).toHaveLength(0);
    expect(result.totalPaid).toBe(0);
    expect(byId(db.orders, 'o1')).toMatchObject({
      discountAmount: 4,
      total: 0,
      paymentStatus: PaymentStatus.PAID,
      status: OrderStatus.COMPLETED,
    });
    expect(gateway.notifyOrderUpdated).toHaveBeenCalledWith(
      ORG,
      'event-1',
      'o1',
      expect.objectContaining({ paymentStatus: PaymentStatus.PAID }),
    );
  });

  it('stores providerTransactionId and metadata on every payment', async () => {
    const { db, pay } = setup();
    db.organization.settings = { integrations: { sumup: { enabled: true } } };
    db.orders.push(order('o1'), order('o2'));

    await pay({
      orderIds: ['o1', 'o2'],
      paymentMethod: PaymentMethod.SUMUP_TERMINAL,
      providerTransactionId: 'TX-1',
      metadata: { terminal: 'T1' },
    });

    expect(db.payments).toHaveLength(2);
    for (const payment of db.payments) {
      expect(payment).toMatchObject({
        providerTransactionId: 'TX-1',
        paymentProvider: PaymentProvider.SUMUP,
        metadata: expect.objectContaining({
          terminal: 'T1',
          batchOrderCount: 2,
        }) as unknown,
      });
    }
    expect(db.payments[0].metadata).toEqual(
      expect.objectContaining({
        batchId: (db.payments[1].metadata as { batchId: string }).batchId,
      }),
    );
  });

  it('test mode: refuses SumUp terminal payments for test orders', async () => {
    const { db, pay } = setup();
    db.organization.settings = { integrations: { sumup: { enabled: true } } };
    db.events[0].status = EventStatus.TEST;
    db.orders.push(order('o1'));

    await expect(
      pay({ orderIds: ['o1'], paymentMethod: PaymentMethod.SUMUP_TERMINAL }),
    ).rejects.toMatchObject({
      response: { reason: 'SUMUP_DISABLED_IN_TEST_MODE' },
    });
    expect(db.payments).toHaveLength(0);
    expect(byId(db.orders, 'o1').paymentStatus).toBe(PaymentStatus.UNPAID);
  });

  it.each([[PaymentMethod.CASH], [PaymentMethod.CARD]])(
    'test mode: %s payments are still booked',
    async (paymentMethod) => {
      const { db, pay } = setup();
      db.events[0].status = EventStatus.TEST;
      db.orders.push(order('o1'));

      await pay({
        orderIds: ['o1'],
        paymentMethod: paymentMethod as BatchPaymentDto['paymentMethod'],
        amountReceived: 10,
      });
      expect(db.payments).toHaveLength(1);
    },
  );

  it('refuses SumUp when the integration is off', async () => {
    const { db, pay } = setup();
    db.orders.push(order('o1'));
    await expect(
      pay({ orderIds: ['o1'], paymentMethod: PaymentMethod.SUMUP_TERMINAL }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.payments).toHaveLength(0);
  });

  it('keeps an order open while a station still works on it', async () => {
    const { db, pay } = setup();
    db.orders.push(order('o1'));
    db.items.push(
      item('i1', 'o1', {
        productionStationId: 'station-1',
        status: OrderItemStatus.READY,
      }),
    );

    await pay({ orderIds: ['o1'] });

    expect(byId(db.orders, 'o1')).toMatchObject({
      paymentStatus: PaymentStatus.PAID,
      status: OrderStatus.OPEN,
    });
  });
});
