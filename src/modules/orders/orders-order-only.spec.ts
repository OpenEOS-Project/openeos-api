import { Logger } from '@nestjs/common';
import {
  OrderItemStatus,
  type OrderItem,
} from '../../database/entities/order-item.entity';
import {
  OrderFulfillmentType,
  OrderStatus,
  PaymentStatus,
  type Order,
} from '../../database/entities/order.entity';
import type { User } from '../../database/entities';
import type { CreateOrderDto } from './dto';
import { OrdersService } from './orders.service';
import { saveOrderWithNumbers } from './order-numbering';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));
jest.mock('./order-numbering', () => ({
  saveOrderWithNumbers: jest.fn(),
}));

const ORG = 'org-1';
const user = { id: 'user-1' } as User;
type Row = Record<string, unknown>;

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

/**
 * Bestellungen aus der Verwaltung im Modus „Nur Bons“: dieselben
 * Regeln wie an der Kasse (Abschluss ohne Zahlung, sobald an keiner
 * Station mehr etwas zu tun ist) und nichts bleibt in einer
 * abgeschlossenen Bestellung auf „offen“.
 */
function setup(orgSettings: Row, items: Row[]) {
  const orders: Row[] = [];
  const orderRepository = {
    update: jest.fn((where: { id: string }, patch: Row) => {
      Object.assign(orders.find((o) => o.id === where.id) ?? {}, patch);
      return Promise.resolve({ affected: 1 });
    }),
    save: jest.fn((order: Row) => Promise.resolve(order)),
  };
  const orderItemRepository = {
    find: jest.fn(() => Promise.resolve(items)),
    save: jest.fn((list: Row[]) => Promise.resolve(list)),
  };
  const organizationRepository = {
    findOne: jest.fn(() =>
      Promise.resolve({ id: ORG, settings: {}, ...orgSettings }),
    ),
  };
  const orderPrintService = {
    handleOrderCreated: jest.fn(() => Promise.resolve()),
  };
  const productionStationRepository = {
    findOne: jest.fn(() => Promise.resolve(null)),
  };
  const none = undefined as never;
  const service = new OrdersService(
    orderRepository as never,
    orderItemRepository as never,
    none,
    organizationRepository as never,
    none,
    none,
    none,
    productionStationRepository as never,
    orderPrintService as never,
    none,
    none,
    none,
  );
  const internals = service as unknown as Record<string, unknown>;
  internals.checkMembership = jest.fn(() => Promise.resolve());
  internals.shouldChargePfand = jest.fn(() => Promise.resolve(false));
  internals.addItemToOrder = jest.fn(() => Promise.resolve());
  internals.recalculateOrderTotals = jest.fn(() => Promise.resolve());
  internals.findOne = jest.fn((_org: string, id: string) =>
    Promise.resolve({ ...orders.find((o) => o.id === id), items }),
  );

  (saveOrderWithNumbers as jest.Mock).mockImplementation(
    (_repo: unknown, _scope: unknown, data: Row) => {
      const order = {
        id: 'order-1',
        orderNumber: 'N-1',
        completedAt: null,
        ...data,
      };
      orders.push(order);
      return Promise.resolve(order);
    },
  );

  return { service, orders, orderItemRepository, orderRepository };
}

const item = (
  id: string,
  status: OrderItemStatus,
  productionStationId: string | null = null,
): Row => ({ id, status, productionStationId, deliveredAt: null });

const createDto = (fulfillmentType: OrderFulfillmentType): CreateOrderDto =>
  ({
    fulfillmentType,
    items: [{ productId: 'p-1', quantity: 1 }],
  }) as unknown as CreateOrderDto;

const orderOnly = { operatingMode: 'orders_only' };

describe('OrdersService.create — „Nur Bons“', () => {
  it('a counter order without station work completes at once, items are handed over', async () => {
    const items = [item('i1', OrderItemStatus.PENDING)];
    const t = setup(orderOnly, items);

    const created = await t.service.create(
      ORG,
      createDto(OrderFulfillmentType.COUNTER_PICKUP),
      user,
    );

    expect(created).toMatchObject({
      status: OrderStatus.COMPLETED,
      paymentStatus: PaymentStatus.UNPAID,
    });
    expect(t.orders[0].completedAt).toBeInstanceOf(Date);
    expect(items[0]).toMatchObject({ status: OrderItemStatus.DELIVERED });
    expect(items[0].deliveredAt).toBeInstanceOf(Date);
  });

  it('stays open while a station still has to prepare something', async () => {
    const items = [
      item('i1', OrderItemStatus.PENDING, 'kitchen'),
      item('i2', OrderItemStatus.PENDING),
    ];
    const t = setup(orderOnly, items);

    const created = await t.service.create(
      ORG,
      createDto(OrderFulfillmentType.COUNTER_PICKUP),
      user,
    );

    expect(created.status).toBe(OrderStatus.OPEN);
    expect(items.map((i) => i.status)).toEqual([
      OrderItemStatus.PENDING,
      OrderItemStatus.PENDING,
    ]);
    expect(t.orderRepository.update).not.toHaveBeenCalled();
  });

  it('a table order stays open until it is closed', async () => {
    const t = setup(orderOnly, [item('i1', OrderItemStatus.PENDING)]);
    const created = await t.service.create(
      ORG,
      createDto(OrderFulfillmentType.TABLE_SERVICE),
      user,
    );
    expect(created.status).toBe(OrderStatus.OPEN);
  });

  it('cash register mode: a new order is never completed without payment', async () => {
    const t = setup({}, [item('i1', OrderItemStatus.PENDING)]);
    const created = await t.service.create(
      ORG,
      createDto(OrderFulfillmentType.COUNTER_PICKUP),
      user,
    );
    expect(created.status).toBe(OrderStatus.OPEN);
    expect(t.orderItemRepository.find).not.toHaveBeenCalled();
  });
});

describe('OrdersService.completeOrder — „Nur Bons“', () => {
  function withOrder(orgSettings: Row, items: Row[]) {
    const t = setup(orgSettings, items);
    t.orders.push({
      id: 'order-1',
      status: OrderStatus.IN_PROGRESS,
      paymentStatus: PaymentStatus.UNPAID,
      fulfillmentType: OrderFulfillmentType.COUNTER_PICKUP,
    });
    return t;
  }

  it('completes without payment and marks items without a station delivered', async () => {
    const items = [
      item('i1', OrderItemStatus.DELIVERED, 'kitchen'),
      item('i2', OrderItemStatus.PENDING),
      item('i3', OrderItemStatus.CANCELLED),
    ];
    const t = withOrder(orderOnly, items);

    await t.service.completeOrder(ORG, 'order-1', user);

    const saved = t.orderRepository.save.mock.calls[0][0] as unknown as Order;
    expect(saved.status).toBe(OrderStatus.COMPLETED);
    expect(items.map((i) => i.status)).toEqual([
      OrderItemStatus.DELIVERED,
      OrderItemStatus.DELIVERED,
      OrderItemStatus.CANCELLED,
    ]);
    const handedOver = t.orderItemRepository.save.mock
      .calls[0][0] as unknown as OrderItem[];
    expect(handedOver.map((i) => i.id)).toEqual(['i2']);
  });

  it('refuses while a station is still working', async () => {
    const items = [item('i1', OrderItemStatus.PREPARING, 'kitchen')];
    const t = withOrder(orderOnly, items);
    await expect(
      t.service.completeOrder(ORG, 'order-1', user),
    ).rejects.toMatchObject({
      response: { reason: 'ORDER_ITEMS_IN_PRODUCTION' },
    });
    expect(t.orderRepository.save).not.toHaveBeenCalled();
  });
});
