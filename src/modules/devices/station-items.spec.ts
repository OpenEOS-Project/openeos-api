import { BadRequestException } from '@nestjs/common';
import { Device } from '../../database/entities/device.entity';
import {
  OrderItem,
  OrderItemStatus,
} from '../../database/entities/order-item.entity';
import {
  Order,
  OrderFulfillmentType,
  OrderPriority,
  OrderSource,
} from '../../database/entities/order.entity';
import { DeviceApiController } from './device-api.controller';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

const ORG = '0f6b2a9e-1c1d-4c3e-9a51-6f4f3c2b1a01';
const STATION = '0f6b2a9e-1c1d-4c3e-9a51-6f4f3c2b1a40';
const CREATED = new Date('2026-10-08T12:00:00Z');

function makeOrder(overrides: Partial<Order>): Order {
  return {
    id: 'o1',
    orderNumber: 'A-0001',
    dailyNumber: 1,
    tableNumber: null,
    customerName: null,
    customerPhone: '+49 170 0000000',
    priority: OrderPriority.NORMAL,
    createdAt: CREATED,
    fulfillmentType: OrderFulfillmentType.COUNTER_PICKUP,
    source: OrderSource.POS,
    notes: null,
    ...overrides,
  } as Order;
}

function makeItem(
  id: string,
  order: Order,
  overrides: Partial<OrderItem> = {},
) {
  return {
    id,
    order,
    productName: 'Pommes',
    categoryName: 'Essen',
    quantity: 1,
    status: OrderItemStatus.PENDING,
    notes: null,
    kitchenNotes: null,
    options: { selected: [] },
    createdAt: CREATED,
    unitPrice: 4.5,
    ...overrides,
  } as unknown as OrderItem;
}

function setup(items: OrderItem[]) {
  const qb = {
    leftJoinAndSelect: () => qb,
    where: () => qb,
    andWhere: () => qb,
    orderBy: () => qb,
    addOrderBy: () => qb,
    getMany: () => Promise.resolve(items),
  };
  const args = Array.from({ length: 23 }, () => undefined as unknown);
  args[5] = { createQueryBuilder: jest.fn(() => qb) };
  const controller = new (DeviceApiController as unknown as new (
    ...a: unknown[]
  ) => DeviceApiController)(...args);
  const device = {
    id: 'd1',
    organizationId: ORG,
    settings: { stationId: STATION },
  } as unknown as Device;
  return { controller, device };
}

describe('DeviceApiController.getStationItems', () => {
  it('returns order context incl. notes (To-go) per order and groups items', async () => {
    const togo = makeOrder({ id: 'o1', notes: 'To-go' });
    const table = makeOrder({
      id: 'o2',
      orderNumber: 'A-0002',
      dailyNumber: 2,
      tableNumber: 'A05',
      customerName: 'Mia',
      fulfillmentType: OrderFulfillmentType.TABLE_SERVICE,
    });
    const { controller, device } = setup([
      makeItem('i1', togo, { kitchenNotes: 'ohne Salz' }),
      makeItem('i2', table),
      makeItem('i3', togo, { notes: 'extra Ketchup' }),
    ]);

    const { data } = await controller.getStationItems(device);

    expect(data).toHaveLength(2);
    expect(data[0]).toEqual({
      order: {
        id: 'o1',
        orderNumber: 'A-0001',
        dailyNumber: 1,
        tableNumber: null,
        customerName: null,
        priority: OrderPriority.NORMAL,
        createdAt: CREATED,
        fulfillmentType: OrderFulfillmentType.COUNTER_PICKUP,
        source: OrderSource.POS,
        notes: 'To-go',
      },
      items: [
        {
          id: 'i1',
          productName: 'Pommes',
          categoryName: 'Essen',
          quantity: 1,
          status: OrderItemStatus.PENDING,
          notes: null,
          kitchenNotes: 'ohne Salz',
          options: { selected: [] },
          createdAt: CREATED,
        },
        expect.objectContaining({ id: 'i3', notes: 'extra Ketchup' }),
      ],
    });
    expect(data[1].order).toMatchObject({
      id: 'o2',
      tableNumber: 'A05',
      customerName: 'Mia',
      fulfillmentType: OrderFulfillmentType.TABLE_SERVICE,
      notes: null,
    });
    expect(data[1].items.map((i) => i.id)).toEqual(['i2']);
  });

  it('does not expose further personal data or prices', async () => {
    const { controller, device } = setup([makeItem('i1', makeOrder({}))]);
    const { data } = await controller.getStationItems(device);
    expect(data[0].order).not.toHaveProperty('customerPhone');
    expect(data[0].items[0]).not.toHaveProperty('unitPrice');
  });

  it('rejects a device without configured station', async () => {
    const { controller } = setup([]);
    await expect(
      controller.getStationItems({
        id: 'd1',
        organizationId: ORG,
        settings: {},
      } as unknown as Device),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
