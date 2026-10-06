import { Logger } from '@nestjs/common';
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
import { OrdersService, orderStatusFromItems } from './orders.service';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

const ORG = 'org-1';
type Row = Record<string, unknown> & { id: string };

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

function matches(value: unknown, condition: unknown): boolean {
  if (condition instanceof FindOperator) {
    return (condition.value as unknown as unknown[]).includes(value);
  }
  return value === condition;
}

function setup() {
  let orders: Row[] = [];
  let items: Row[] = [];
  const locks: unknown[] = [];
  const rowsOf = (entity: unknown) => (entity === Order ? orders : items);
  const filter = (entity: unknown, where: Record<string, unknown>) =>
    rowsOf(entity).filter((row) =>
      Object.entries(where).every(([k, v]) => matches(row[k], v)),
    );

  const manager = {
    find: (
      entity: unknown,
      opts: { where: Record<string, unknown>; lock?: unknown },
    ) => {
      if (opts.lock) locks.push(opts.lock);
      return Promise.resolve(filter(entity, opts.where).map((r) => ({ ...r })));
    },
    findOne: (
      entity: unknown,
      opts: { where: Record<string, unknown>; relations?: string[] },
    ) => {
      const row = filter(entity, opts.where)[0];
      if (!row) return Promise.resolve(null);
      return Promise.resolve({
        ...row,
        items: items.filter((i) => i.orderId === row.id).map((i) => ({ ...i })),
      });
    },
    save: (list: Row[]) => {
      for (const row of list) {
        const index = items.findIndex((i) => i.id === row.id);
        items[index] = { ...row };
      }
      return Promise.resolve(list);
    },
    update: (
      _entity: unknown,
      where: { id: string },
      patch: Record<string, unknown>,
    ) => {
      Object.assign(orders.find((o) => o.id === where.id)!, patch);
      return Promise.resolve({ affected: 1 });
    },
  };
  const orderRepository = {
    manager: {
      transaction: async (work: (m: unknown) => Promise<unknown>) => {
        const snapshot = JSON.stringify([orders, items]);
        try {
          return await work(manager);
        } catch (error) {
          [orders, items] = JSON.parse(snapshot) as Row[][];
          throw error;
        }
      },
    },
  };
  const gatewayService = {
    notifyOrderItemStatusChanged: jest.fn(),
    notifyOrderUpdated: jest.fn(),
  };
  const none = undefined as never;
  const service = new OrdersService(
    orderRepository as never,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    gatewayService as never,
    none,
  );

  return {
    service,
    gatewayService,
    locks,
    seed(o: Row[], i: Row[]) {
      orders = o;
      items = i;
    },
    order: (id: string) => orders.find((o) => o.id === id)!,
    item: (id: string) => items.find((i) => i.id === id)!,
  };
}

const order = (id: string, extra: Partial<Order> = {}) =>
  ({
    id,
    organizationId: ORG,
    eventId: 'event-1',
    orderNumber: `N-${id}`,
    status: OrderStatus.IN_PROGRESS,
    paymentStatus: PaymentStatus.UNPAID,
    completedAt: null,
    ...extra,
  }) as unknown as Row;

const item = (id: string, orderId: string, status: OrderItemStatus): Row => ({
  id,
  orderId,
  status,
  productName: `P-${id}`,
  deliveredAt: null,
});

describe('orderStatusFromItems', () => {
  it('keeps the rule of updateOrderStatus', () => {
    const s = (status: OrderItemStatus) => ({ status });
    expect(orderStatusFromItems([], OrderStatus.IN_PROGRESS)).toBe(
      OrderStatus.OPEN,
    );
    expect(
      orderStatusFromItems(
        [s(OrderItemStatus.DELIVERED), s(OrderItemStatus.CANCELLED)],
        OrderStatus.OPEN,
      ),
    ).toBe(OrderStatus.READY);
    expect(
      orderStatusFromItems(
        [s(OrderItemStatus.READY), s(OrderItemStatus.PENDING)],
        OrderStatus.OPEN,
      ),
    ).toBe(OrderStatus.IN_PROGRESS);
    expect(
      orderStatusFromItems([s(OrderItemStatus.PENDING)], OrderStatus.OPEN),
    ).toBe(OrderStatus.OPEN);
  });
});

describe('OrdersService.deliverItemsForDevice', () => {
  it('moves ready items to delivered and updates the order', async () => {
    const t = setup();
    t.seed(
      [order('o1'), order('o2', { paymentStatus: PaymentStatus.PAID })],
      [
        item('i1', 'o1', OrderItemStatus.READY),
        item('i2', 'o1', OrderItemStatus.PREPARING),
        item('i3', 'o2', OrderItemStatus.READY),
      ],
    );

    const result = await t.service.deliverItemsForDevice(ORG, ['i1', 'i3']);

    expect(t.item('i1')).toMatchObject({ status: OrderItemStatus.DELIVERED });
    expect(t.item('i1').deliveredAt).toBeInstanceOf(Date);
    expect(t.item('i2').status).toBe(OrderItemStatus.PREPARING);
    // o1 laeuft noch (i2), o2 ist ausgegeben und bezahlt → abgeschlossen.
    expect(t.order('o1').status).toBe(OrderStatus.IN_PROGRESS);
    expect(t.order('o2')).toMatchObject({ status: OrderStatus.COMPLETED });
    expect(t.order('o2').completedAt).toBeInstanceOf(Date);
    expect(result.delivered.map((d) => d.id)).toEqual(['i1', 'i3']);
    expect(result.skipped).toEqual([]);
    expect(t.locks).toEqual([{ mode: 'pessimistic_write' }]);

    expect(t.gatewayService.notifyOrderItemStatusChanged).toHaveBeenCalledTimes(
      2,
    );
    expect(t.gatewayService.notifyOrderItemStatusChanged).toHaveBeenCalledWith(
      ORG,
      'event-1',
      expect.objectContaining({
        itemId: 'i1',
        status: OrderItemStatus.DELIVERED,
        previousStatus: OrderItemStatus.READY,
      }),
    );
    expect(t.gatewayService.notifyOrderUpdated).toHaveBeenCalledTimes(1);
    expect(t.gatewayService.notifyOrderUpdated).toHaveBeenCalledWith(
      ORG,
      'event-1',
      'o2',
      expect.objectContaining({ status: OrderStatus.COMPLETED }),
    );
  });

  it('unpaid orders become ready (served, still to be paid)', async () => {
    const t = setup();
    t.seed([order('o1')], [item('i1', 'o1', OrderItemStatus.READY)]);
    await t.service.deliverItemsForDevice(ORG, ['i1']);
    expect(t.order('o1').status).toBe(OrderStatus.READY);
  });

  it('skips items that were already delivered', async () => {
    const t = setup();
    t.seed([order('o1')], [item('i1', 'o1', OrderItemStatus.DELIVERED)]);
    const result = await t.service.deliverItemsForDevice(ORG, ['i1', 'i1']);
    expect(result).toEqual({ delivered: [], skipped: ['i1'], orders: [] });
    expect(
      t.gatewayService.notifyOrderItemStatusChanged,
    ).not.toHaveBeenCalled();
  });

  it('only ready → delivered: a pending item rejects the whole call', async () => {
    const t = setup();
    t.seed(
      [order('o1')],
      [
        item('i1', 'o1', OrderItemStatus.READY),
        item('i2', 'o1', OrderItemStatus.PENDING),
      ],
    );
    await expect(
      t.service.deliverItemsForDevice(ORG, ['i1', 'i2']),
    ).rejects.toMatchObject({
      response: { reason: 'ORDER_ITEM_NOT_READY', params: { itemIds: ['i2'] } },
    });
    expect(t.item('i1').status).toBe(OrderItemStatus.READY);
  });

  it('items of another organization are not found (404)', async () => {
    const t = setup();
    t.seed(
      [order('o1', { organizationId: 'org-2' } as Partial<Order>)],
      [item('i1', 'o1', OrderItemStatus.READY)],
    );
    await expect(
      t.service.deliverItemsForDevice(ORG, ['i1']),
    ).rejects.toMatchObject({
      status: 404,
      response: { reason: 'ORDER_ITEM_NOT_FOUND' },
    });
    expect(t.item('i1').status).toBe(OrderItemStatus.READY);
  });
});

/** Fertig an der Station → Kassen erfahren es sofort (Tisch „wartet“). */
describe('OrdersService.markItemReadyFromDevice', () => {
  it('emits orderItemStatusChanged', async () => {
    const itemRow = {
      id: 'i1',
      productName: 'Pommes',
      status: OrderItemStatus.PREPARING,
      order: { id: 'o1', organizationId: ORG },
    } as unknown as OrderItem;
    const orderRow = {
      id: 'o1',
      organizationId: ORG,
      eventId: 'event-1',
      orderNumber: 'N-1',
      items: [itemRow],
    } as unknown as Order;
    const orderRepository = {
      findOne: jest.fn(() => Promise.resolve(orderRow)),
      save: jest.fn((o: Order) => Promise.resolve(o)),
    };
    const orderItemRepository = {
      findOne: jest.fn(() => Promise.resolve(itemRow)),
      save: jest.fn((i: OrderItem) => Promise.resolve(i)),
    };
    const gatewayService = { notifyOrderItemStatusChanged: jest.fn() };
    const none = undefined as never;
    const service = new OrdersService(
      orderRepository as never,
      orderItemRepository as never,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      gatewayService as never,
      none,
    );

    await service.markItemReadyFromDevice(ORG, 'i1');

    expect(gatewayService.notifyOrderItemStatusChanged).toHaveBeenCalledWith(
      ORG,
      'event-1',
      expect.objectContaining({
        itemId: 'i1',
        status: OrderItemStatus.READY,
        previousStatus: OrderItemStatus.PREPARING,
      }),
    );
  });
});
