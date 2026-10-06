import {
  BadRequestException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { Device } from '../../database/entities/device.entity';
import { Event, EventStatus } from '../../database/entities/event.entity';
import { OrderItem } from '../../database/entities/order-item.entity';
import {
  Order,
  OrderFulfillmentType,
  OrderStatus,
  PaymentStatus,
} from '../../database/entities/order.entity';
import { Organization } from '../../database/entities/organization.entity';
import { Product } from '../../database/entities/product.entity';
import { CreateOrderDto } from '../orders/dto';
import { DeviceApiController } from './device-api.controller';
import {
  CLIENT_REQUEST_INDEX,
  DeviceTableLookup,
  TableCandidate,
  resolveDeviceOrderTable,
} from './device-order-table';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

const ORG = '0f6b2a9e-1c1d-4c3e-9a51-6f4f3c2b1a01';
const EVENT = '0f6b2a9e-1c1d-4c3e-9a51-6f4f3c2b1a02';
const OTHER_EVENT = '0f6b2a9e-1c1d-4c3e-9a51-6f4f3c2b1a03';
const AREA_A = '0f6b2a9e-1c1d-4c3e-9a51-6f4f3c2b1a10';
const AREA_B = '0f6b2a9e-1c1d-4c3e-9a51-6f4f3c2b1a11';
const T_A03 = '0f6b2a9e-1c1d-4c3e-9a51-6f4f3c2b1a20';
const T_B01 = '0f6b2a9e-1c1d-4c3e-9a51-6f4f3c2b1a21';
const T_OFF = '0f6b2a9e-1c1d-4c3e-9a51-6f4f3c2b1a22';
const PRODUCT = '0f6b2a9e-1c1d-4c3e-9a51-6f4f3c2b1a30';

const TABLES: TableCandidate[] = [
  { id: T_A03, label: 'A03', areaId: AREA_A, isActive: true },
  { id: T_B01, label: 'B01', areaId: AREA_B, isActive: true },
  { id: T_OFF, label: 'A99', areaId: AREA_A, isActive: false },
];

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

function lookup(): DeviceTableLookup {
  const byKey = (label: string) =>
    TABLES.find((t) => t.label.toUpperCase() === label.trim().toUpperCase()) ??
    null;
  return {
    byId: (id) => Promise.resolve(TABLES.find((t) => t.id === id) ?? null),
    byLabel: (label) => Promise.resolve(byKey(label)),
    idByLabel: (label) => {
      const hit = byKey(label);
      return Promise.resolve(hit?.isActive ? hit.id : null);
    },
  };
}

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { response: { reason: string } }).response.reason;
  }
  throw new Error('expected an error');
}

describe('resolveDeviceOrderTable (matrix §2.3)', () => {
  const counter = {
    fulfillmentType: OrderFulfillmentType.COUNTER_PICKUP,
    tableNumber: null,
    tableId: null,
  };

  it.each([
    ['counter device, free', 'counter', { mode: 'free' as const }],
    ['counter device, predefined', 'counter', { mode: 'predefined' as const }],
    ['table device, none', 'table', { mode: 'none' as const }],
  ])('%s → counter_pickup without table', async (_n, serviceMode, tables) => {
    await expect(
      resolveDeviceOrderTable(
        {
          serviceMode,
          eventTables: tables,
          tableId: T_A03,
          tableNumber: 'A03',
        },
        lookup(),
      ),
    ).resolves.toEqual(counter);
  });

  it('override counter_pickup on a table device drops the table (free + predefined)', async () => {
    for (const mode of ['free', 'predefined'] as const) {
      await expect(
        resolveDeviceOrderTable(
          {
            serviceMode: 'table',
            eventTables: { mode },
            fulfillmentType: OrderFulfillmentType.COUNTER_PICKUP,
            tableId: T_A03,
          },
          lookup(),
        ),
      ).resolves.toEqual(counter);
    }
  });

  it('table_service in the body is ignored on a counter device', async () => {
    await expect(
      resolveDeviceOrderTable(
        {
          serviceMode: 'counter',
          eventTables: { mode: 'free' },
          fulfillmentType: OrderFulfillmentType.TABLE_SERVICE,
          tableNumber: '12',
        },
        lookup(),
      ),
    ).resolves.toEqual(counter);
  });

  describe('free (default when the event has no table settings)', () => {
    it('keeps a free number and links a matching table best effort', async () => {
      await expect(
        resolveDeviceOrderTable(
          {
            serviceMode: undefined,
            eventTables: undefined,
            tableNumber: 'a03',
          },
          lookup(),
        ),
      ).resolves.toEqual({
        fulfillmentType: OrderFulfillmentType.TABLE_SERVICE,
        tableNumber: 'a03',
        tableId: T_A03,
      });
    });

    it('keeps an unknown number without a table and never rejects', async () => {
      await expect(
        resolveDeviceOrderTable(
          { serviceMode: 'table', tableNumber: '12' },
          lookup(),
        ),
      ).resolves.toEqual({
        fulfillmentType: OrderFulfillmentType.TABLE_SERVICE,
        tableNumber: '12',
        tableId: null,
      });
    });

    it('uses a valid tableId and its label when no number is sent', async () => {
      await expect(
        resolveDeviceOrderTable(
          { serviceMode: 'table', tableId: T_B01 },
          lookup(),
        ),
      ).resolves.toEqual({
        fulfillmentType: OrderFulfillmentType.TABLE_SERVICE,
        tableNumber: 'B01',
        tableId: T_B01,
      });
    });

    it('ignores an inactive or unknown tableId', async () => {
      await expect(
        resolveDeviceOrderTable(
          { serviceMode: 'table', tableId: T_OFF, tableNumber: '7' },
          lookup(),
        ),
      ).resolves.toEqual({
        fulfillmentType: OrderFulfillmentType.TABLE_SERVICE,
        tableNumber: '7',
        tableId: null,
      });
    });

    it('allows table service without any number (as before)', async () => {
      await expect(
        resolveDeviceOrderTable({ serviceMode: 'table' }, lookup()),
      ).resolves.toEqual({
        fulfillmentType: OrderFulfillmentType.TABLE_SERVICE,
        tableNumber: null,
        tableId: null,
      });
    });
  });

  describe('predefined', () => {
    const predefined = { mode: 'predefined' as const, areaIds: [AREA_A] };

    it('requires a table', async () => {
      const call = resolveDeviceOrderTable(
        { serviceMode: 'table', eventTables: predefined },
        lookup(),
      );
      await expect(call).rejects.toBeInstanceOf(BadRequestException);
      expect(await reason(call)).toBe('TABLE_REQUIRED');
    });

    it('takes the label snapshot of the table', async () => {
      await expect(
        resolveDeviceOrderTable(
          {
            serviceMode: 'table',
            eventTables: predefined,
            tableId: T_A03,
            tableNumber: 'whatever',
          },
          lookup(),
        ),
      ).resolves.toEqual({
        fulfillmentType: OrderFulfillmentType.TABLE_SERVICE,
        tableNumber: 'A03',
        tableId: T_A03,
      });
    });

    it('resolves a number to the table when no tableId is sent', async () => {
      await expect(
        resolveDeviceOrderTable(
          {
            serviceMode: 'table',
            eventTables: predefined,
            tableNumber: 'a03 ',
          },
          lookup(),
        ),
      ).resolves.toMatchObject({ tableId: T_A03, tableNumber: 'A03' });
    });

    it.each([
      ['inactive', { tableId: T_OFF }],
      ['outside the event areas', { tableId: T_B01 }],
      ['unknown id', { tableId: '0f6b2a9e-1c1d-4c3e-9a51-6f4f3c2b1aff' }],
      ['unknown number', { tableNumber: '12' }],
    ])('rejects a table that is %s', async (_n, table) => {
      const call = resolveDeviceOrderTable(
        { serviceMode: 'table', eventTables: predefined, ...table },
        lookup(),
      );
      await expect(call).rejects.toBeInstanceOf(NotFoundException);
      expect(await reason(call)).toBe('TABLE_NOT_FOUND');
    });

    it('accepts every area when areaIds is null', async () => {
      await expect(
        resolveDeviceOrderTable(
          {
            serviceMode: 'table',
            eventTables: { mode: 'predefined', areaIds: null },
            tableId: T_B01,
          },
          lookup(),
        ),
      ).resolves.toMatchObject({ tableId: T_B01 });
    });
  });
});

// ---------------------------------------------------------------------------
// DeviceApiController.createOrder / getOpenOrders mit kleiner In-Memory-DB

type Row = Record<string, unknown> & { id: string };

function instance<T extends object>(
  entity: new () => T,
  data: Record<string, unknown>,
): T {
  return Object.assign(Object.create(entity.prototype as object) as T, data);
}

class FakeDb {
  orders: Row[] = [];
  items: Row[] = [];
  products: Row[] = [];
  events: Row[] = [];
  organizations: Row[] = [{ id: ORG, settings: {} }];
  private seq = 0;

  rowsOf(entity: unknown): Row[] {
    if (entity === Order) return this.orders;
    if (entity === OrderItem) return this.items;
    if (entity === Product) return this.products;
    if (entity === Event) return this.events;
    if (entity === Organization) return this.organizations;
    throw new Error(`unexpected entity ${String(entity)}`);
  }

  private matches(row: Row, where: Record<string, unknown> = {}) {
    return Object.entries(where).every(([k, v]) => row[k] === v);
  }

  private hydrate(entity: unknown, row: Row) {
    if (entity !== Order) return row;
    return Object.assign(row, {
      items: this.items.filter((i) => i.orderId === row.id),
    });
  }

  repo(entity: unknown) {
    const rows = () => this.rowsOf(entity);
    return {
      manager: this.manager(),
      findOne: (opts: { where: Record<string, unknown> }) =>
        Promise.resolve(
          rows().find((r) => this.matches(r, opts.where))
            ? this.hydrate(
                entity,
                rows().find((r) => this.matches(r, opts.where))!,
              )
            : null,
        ),
      count: (opts: { where?: Record<string, unknown> } = {}) =>
        Promise.resolve(
          rows().filter((r) => this.matches(r, opts.where)).length,
        ),
      create: (data: Record<string, unknown>) =>
        instance(entity as new () => object, data),
      save: (row: Row | Row[]) => this.save(entity, row),
    };
  }

  save(entity: unknown, input: Row | Row[]) {
    const list = Array.isArray(input) ? input : [input];
    const rows = this.rowsOf(entity);
    for (const row of list) {
      if (
        entity === Order &&
        row.clientRequestId &&
        rows.some(
          (r) =>
            r.id !== row.id &&
            r.organizationId === row.organizationId &&
            r.clientRequestId === row.clientRequestId,
        )
      ) {
        throw new QueryFailedError('INSERT', [], {
          code: '23505',
          constraint: CLIENT_REQUEST_INDEX,
        } as unknown as Error);
      }
      if (!row.id)
        row.id = `${String((entity as { name: string }).name)}-${++this.seq}`;
      const { items: _items, ...plain } = row as Row & { items?: unknown };
      const index = rows.findIndex((r) => r.id === row.id);
      if (index >= 0) Object.assign(rows[index], plain);
      else rows.push(plain as Row);
    }
    return Promise.resolve(input);
  }

  private shared?: Record<string, unknown>;

  manager() {
    if (this.shared) return this.shared;
    const manager: Record<string, unknown> = {
      transaction: async (work: (m: unknown) => Promise<unknown>) => {
        const snapshot = JSON.stringify([
          this.orders,
          this.items,
          this.products,
        ]);
        try {
          return await work(manager);
        } catch (error) {
          const [orders, items, products] = JSON.parse(snapshot) as Row[][];
          this.orders.splice(0, this.orders.length, ...orders);
          this.items.splice(0, this.items.length, ...items);
          this.products.splice(0, this.products.length, ...products);
          throw error;
        }
      },
      query: (sql: string, params: unknown[]) => {
        if (sql.includes('dining_tables')) {
          const [, value] = params as string[];
          const hit = sql.includes('t.id = $2')
            ? TABLES.find((t) => t.id === value)
            : TABLES.find(
                (t) => t.label.toUpperCase() === value.trim().toUpperCase(),
              );
          if (sql.includes('AND is_active')) {
            return Promise.resolve(hit?.isActive ? [{ id: hit.id }] : []);
          }
          return Promise.resolve(hit ? [hit] : []);
        }
        // advisory lock + MAX() der Nummernvergabe
        return Promise.resolve([{ max: null }]);
      },
      getRepository: (entity: unknown) => this.repo(entity),
      findOne: (entity: unknown, opts: { where: Record<string, unknown> }) =>
        this.repo(entity).findOne(opts),
      create: (entity: new () => object, data: Record<string, unknown>) =>
        instance(entity, data),
      save: (row: Row) =>
        this.save(
          (row as object).constructor === Object ? Order : row.constructor,
          row,
        ),
    };
    this.shared = manager;
    return manager;
  }
}

function makeController(deps: Record<number, unknown>): DeviceApiController {
  const args = Array.from({ length: 22 }, (_, i) => deps[i]);
  return new (DeviceApiController as unknown as new (
    ...a: unknown[]
  ) => DeviceApiController)(...args);
}

function setupController(
  options: {
    serviceMode?: 'table' | 'counter';
    tables?: Event['settings']['tables'];
    eventStatus?: EventStatus;
  } = {},
) {
  const db = new FakeDb();
  db.events.push({
    id: EVENT,
    organizationId: ORG,
    status: options.eventStatus ?? EventStatus.ACTIVE,
    settings: options.tables ? { tables: options.tables } : {},
  });
  db.products.push({
    id: PRODUCT,
    eventId: EVENT,
    name: 'Bier',
    price: 4.5,
    taxRate: 19,
    isActive: true,
    isAvailable: true,
    trackInventory: true,
    stockQuantity: 10,
    categoryId: null,
    category: null,
    pfandType: null,
    pfandTypeId: null,
    productionStationId: null,
  });

  const manager = db.manager();
  const orderRepository = { ...db.repo(Order), manager };
  const eventRepository = db.repo(Event);
  const gatewayService = {
    notifyOrderCreated: jest.fn(),
    notifyProductUpdated: jest.fn(),
  };
  const orderPrintService = {
    handleOrderCreated: jest.fn(() => Promise.resolve()),
  };
  const configService = { get: jest.fn(() => 25) };
  // Konstruktor-Reihenfolge siehe DeviceApiController.
  const controller = makeController({
    1: eventRepository,
    4: orderRepository,
    14: gatewayService,
    15: orderPrintService,
    21: configService,
  });

  const device = {
    id: 'device-1',
    name: 'Kasse 1',
    organizationId: ORG,
    settings: options.serviceMode ? { serviceMode: options.serviceMode } : {},
  } as unknown as Device;

  const response = () => ({ status: jest.fn() });

  return {
    db,
    controller,
    device,
    gatewayService,
    orderPrintService,
    response,
  };
}

function dto(extra: Partial<CreateOrderDto> = {}): CreateOrderDto {
  return {
    eventId: EVENT,
    items: [{ productId: PRODUCT, quantity: 2 }],
    ...extra,
  } as CreateOrderDto;
}

describe('DeviceApiController.createOrder', () => {
  it('stores the resolved table for predefined tables', async () => {
    const { controller, device, response } = setupController({
      tables: { mode: 'predefined', areaIds: [AREA_A] },
    });

    const { data } = await controller.createOrder(
      device,
      dto({ tableId: T_A03 }),
      response() as never,
    );

    expect(data).toMatchObject({
      tableId: T_A03,
      tableNumber: 'A03',
      fulfillmentType: OrderFulfillmentType.TABLE_SERVICE,
      total: 9,
    });
  });

  it('rejects predefined without a table and leaves nothing behind', async () => {
    const { db, controller, device, response } = setupController({
      tables: { mode: 'predefined' },
    });

    const call = controller.createOrder(device, dto(), response() as never);
    expect(await reason(call)).toBe('TABLE_REQUIRED');
    expect(db.orders).toHaveLength(0);
  });

  it('rejects a table outside the event areas', async () => {
    const { controller, device, response } = setupController({
      tables: { mode: 'predefined', areaIds: [AREA_A] },
    });
    expect(
      await reason(
        controller.createOrder(
          device,
          dto({ tableId: T_B01 }),
          response() as never,
        ),
      ),
    ).toBe('TABLE_NOT_FOUND');
  });

  it('counter_pickup override at a table device: no table, Theke', async () => {
    const { controller, device, response } = setupController({
      tables: { mode: 'free' },
    });
    const { data } = await controller.createOrder(
      device,
      dto({
        tableNumber: '12',
        fulfillmentType: OrderFulfillmentType.COUNTER_PICKUP,
        notes: 'To-go',
      }),
      response() as never,
    );
    expect(data).toMatchObject({
      tableNumber: null,
      tableId: null,
      fulfillmentType: OrderFulfillmentType.COUNTER_PICKUP,
      notes: 'To-go',
    });
  });

  it('same clientRequestId twice → same order, HTTP 200, no second kitchen ticket', async () => {
    const {
      db,
      controller,
      device,
      gatewayService,
      orderPrintService,
      response,
    } = setupController({ tables: { mode: 'free' } });
    const clientRequestId = '9d4c1f0e-6a51-4b9e-8a0c-1f2e3d4c5b6a';

    const firstResponse = response();
    const first = await controller.createOrder(
      device,
      dto({ tableNumber: '12', clientRequestId }),
      firstResponse as never,
    );
    const secondResponse = response();
    const second = await controller.createOrder(
      device,
      dto({ tableNumber: '12', clientRequestId }),
      secondResponse as never,
    );

    expect(second.data.id).toBe(first.data.id);
    expect(firstResponse.status).not.toHaveBeenCalled();
    expect(secondResponse.status).toHaveBeenCalledWith(HttpStatus.OK);
    expect(db.orders).toHaveLength(1);
    expect(db.items).toHaveLength(1);
    expect(db.products[0].stockQuantity).toBe(8);
    expect(orderPrintService.handleOrderCreated).toHaveBeenCalledTimes(1);
    expect(gatewayService.notifyOrderCreated).toHaveBeenCalledTimes(1);
  });

  it('a concurrent duplicate (unique index) returns the order of the winner', async () => {
    const { db, controller, device, orderPrintService, response } =
      setupController();
    const clientRequestId = '9d4c1f0e-6a51-4b9e-8a0c-1f2e3d4c5b6b';
    // Die andere Anfrage hat zwischen Vorabpruefung und Insert gewonnen.
    const winner = {
      id: 'order-winner',
      organizationId: ORG,
      eventId: EVENT,
      clientRequestId,
      status: OrderStatus.OPEN,
      paymentStatus: PaymentStatus.UNPAID,
    };
    const repo = (
      controller as unknown as {
        orderRepository: { findOne: (o: unknown) => Promise<unknown> };
      }
    ).orderRepository;
    const findOne = repo.findOne;
    let calls = 0;
    repo.findOne = (opts) => {
      calls += 1;
      if (calls === 1) {
        db.orders.push(winner);
        return Promise.resolve(null);
      }
      return findOne(opts);
    };

    const res = response();
    const { data } = await controller.createOrder(
      device,
      dto({ clientRequestId }),
      res as never,
    );

    expect(data.id).toBe('order-winner');
    expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
    expect(db.orders).toHaveLength(1);
    expect(db.items).toHaveLength(0);
    expect(db.products[0].stockQuantity).toBe(10);
    expect(orderPrintService.handleOrderCreated).not.toHaveBeenCalled();
  });

  it('rolls the order back when an item fails (no empty order for a retry)', async () => {
    const { db, controller, device, response } = setupController();
    const clientRequestId = '9d4c1f0e-6a51-4b9e-8a0c-1f2e3d4c5b6c';

    const call = controller.createOrder(
      device,
      dto({
        clientRequestId,
        items: [
          { productId: PRODUCT, quantity: 1 },
          { productId: PRODUCT, quantity: 50 },
        ],
      }),
      response() as never,
    );
    expect(await reason(call)).toBe('INSUFFICIENT_STOCK_FOR_PRODUCT');
    expect(db.orders).toHaveLength(0);
    expect(db.items).toHaveLength(0);
    expect(db.products[0].stockQuantity).toBe(10);
  });
});

// ---------------------------------------------------------------------------

describe('DeviceApiController.getOpenOrders', () => {
  function setup(events: Row[]) {
    const where: { sql: string; params?: Record<string, unknown> }[] = [];
    const qb = {
      leftJoinAndSelect: () => qb,
      where: (sql: string, params?: Record<string, unknown>) => {
        where.push({ sql, params });
        return qb;
      },
      andWhere: (sql: string, params?: Record<string, unknown>) => {
        where.push({ sql, params });
        return qb;
      },
      orderBy: () => qb,
      addOrderBy: () => qb,
      getMany: () => Promise.resolve([{ id: 'o1' }]),
    };
    const eventRepository = {
      find: jest.fn((opts: { where: Record<string, unknown> }) =>
        Promise.resolve(
          events.filter((e) =>
            opts.where.id
              ? e.id === opts.where.id &&
                e.organizationId === opts.where.organizationId
              : e.organizationId === opts.where.organizationId &&
                [EventStatus.ACTIVE, EventStatus.TEST].includes(
                  e.status as EventStatus,
                ),
          ),
        ),
      ),
    };
    const orderRepository = { createQueryBuilder: jest.fn(() => qb) };
    const controller = makeController({
      1: eventRepository,
      4: orderRepository,
    });
    const device = { id: 'd1', organizationId: ORG } as Device;
    return { controller, device, where, orderRepository };
  }

  const param = (
    where: { sql: string; params?: Record<string, unknown> }[],
    key: string,
  ) => where.find((w) => w.params && key in w.params)?.params?.[key];

  it('without eventId only returns orders of the active/test event (no org-wide leak)', async () => {
    const { controller, device, where } = setup([
      { id: EVENT, organizationId: ORG, status: EventStatus.ACTIVE },
      { id: OTHER_EVENT, organizationId: ORG, status: EventStatus.INACTIVE },
    ]);

    await controller.getOpenOrders(device);

    expect(param(where, 'eventIds')).toEqual([EVENT]);
    expect(param(where, 'openPayment')).toEqual(['unpaid', 'partly_paid']);
    expect(param(where, 'closedStatus')).toEqual(['cancelled', 'completed']);
  });

  it('returns nothing when there is no active/test event', async () => {
    const { controller, device, orderRepository } = setup([
      { id: OTHER_EVENT, organizationId: ORG, status: EventStatus.INACTIVE },
    ]);
    await expect(controller.getOpenOrders(device)).resolves.toEqual({
      data: [],
    });
    expect(orderRepository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('ignores an event of another organization', async () => {
    const { controller, device } = setup([
      {
        id: OTHER_EVENT,
        organizationId: 'other-org',
        status: EventStatus.ACTIVE,
      },
    ]);
    await expect(
      controller.getOpenOrders(device, OTHER_EVENT),
    ).resolves.toEqual({ data: [] });
  });

  it('filters by table key, table id and fulfillment type', async () => {
    const { controller, device, where } = setup([
      { id: EVENT, organizationId: ORG, status: EventStatus.TEST },
    ]);

    await controller.getOpenOrders(
      device,
      EVENT,
      ' a03 ',
      T_A03,
      'counter_pickup',
    );

    expect(param(where, 'eventIds')).toEqual([EVENT]);
    expect(param(where, 'tableKey')).toBe('a03');
    expect(param(where, 'tableId')).toBe(T_A03);
    expect(param(where, 'fulfillmentType')).toBe('counter_pickup');
  });
});
