import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Device } from '../../database/entities/device.entity';
import { EventStatus } from '../../database/entities/event.entity';
import {
  DeviceTablesController,
  PRINTER_STALE_MS,
  printerStatus,
  resolveReceiptPrinterId,
} from './device-tables.controller';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

const ORG = 'org-1';
const EVENT = '5b0a3f7e-2f1c-4c5d-8e9f-0a1b2c3d4e01';
const OLD_EVENT = '5b0a3f7e-2f1c-4c5d-8e9f-0a1b2c3d4e02';
const FOREIGN_EVENT = '5b0a3f7e-2f1c-4c5d-8e9f-0a1b2c3d4e03';

type EventRow = {
  id: string;
  organizationId: string;
  status: EventStatus;
  settings: Record<string, unknown>;
};

function setup(
  options: {
    events?: EventRow[];
    orgSettings?: Record<string, unknown>;
    printers?: Record<string, unknown>[];
  } = {},
) {
  const events = options.events ?? [
    {
      id: EVENT,
      organizationId: ORG,
      status: EventStatus.ACTIVE,
      settings: { tables: { mode: 'predefined', areaIds: ['area-a'] } },
    },
  ];
  const eventRepository = {
    findOne: jest.fn(
      (opts: { where: { id: string; organizationId: string } }) =>
        Promise.resolve(
          events.find(
            (e) =>
              e.id === opts.where.id &&
              e.organizationId === opts.where.organizationId,
          ) ?? null,
        ),
    ),
    find: jest.fn((opts: { where: { organizationId: string } }) =>
      Promise.resolve(
        events.filter(
          (e) =>
            e.organizationId === opts.where.organizationId &&
            [EventStatus.ACTIVE, EventStatus.TEST].includes(e.status),
        ),
      ),
    ),
  };

  const updates: {
    where: { sql: string; params?: Record<string, unknown> }[];
  } = {
    where: [],
  };
  const qb = {
    update: () => qb,
    set: () => qb,
    where: (sql: string, params?: Record<string, unknown>) => {
      updates.where.push({ sql, params });
      return qb;
    },
    andWhere: (sql: string, params?: Record<string, unknown>) => {
      updates.where.push({ sql, params });
      return qb;
    },
    returning: () => qb,
    execute: () =>
      Promise.resolve({
        raw: [
          { id: 'guest-1', acknowledged_at: new Date('2026-10-06T12:00:00Z') },
        ],
      }),
  };
  const orderRepository = { createQueryBuilder: jest.fn(() => qb) };
  const organizationRepository = {
    findOne: jest.fn(() =>
      Promise.resolve({ id: ORG, settings: options.orgSettings ?? {} }),
    ),
  };
  const printers = options.printers ?? [];
  const printerRepository = {
    findOne: jest.fn(
      (opts: { where: { id: string; organizationId: string } }) =>
        Promise.resolve(
          printers.find(
            (p) =>
              p.id === opts.where.id &&
              p.organizationId === opts.where.organizationId,
          ) ?? null,
        ),
    ),
  };
  const tablesService = {
    loadAreas: jest.fn(() =>
      Promise.resolve([
        {
          id: 'area-a',
          organizationId: ORG,
          name: 'Zelt A',
          sortOrder: 0,
          width: 1200,
          height: 800,
          gridSize: 20,
          decor: [],
          createdAt: new Date(),
          tables: [
            {
              id: 't1',
              organizationId: ORG,
              areaId: 'area-a',
              label: 'A01',
              seats: 6,
              shape: 'rect',
              x: 20,
              y: 40,
              width: 80,
              height: 80,
              rotation: 0,
              sortOrder: 0,
              isActive: true,
            },
          ],
        },
      ]),
    ),
    getStatus: jest.fn(() => Promise.resolve([{ key: 'A01', status: 'busy' }])),
  };
  const ordersService = {
    deliverItemsForDevice: jest.fn(() =>
      Promise.resolve({ delivered: [], skipped: [], orders: [] }),
    ),
  };
  const paymentsBatchService = { payBatch: jest.fn() };
  const gatewayService = { notifyOrderUpdated: jest.fn() };

  const controller = new DeviceTablesController(
    eventRepository as never,
    orderRepository as never,
    organizationRepository as never,
    printerRepository as never,
    tablesService as never,
    ordersService as never,
    paymentsBatchService as never,
    gatewayService as never,
  );
  const device = (settings: Record<string, unknown> = {}) =>
    ({ id: 'device-1', organizationId: ORG, settings }) as unknown as Device;

  return {
    controller,
    device,
    tablesService,
    ordersService,
    gatewayService,
    updates,
  };
}

describe('DeviceTablesController', () => {
  describe('GET tables', () => {
    it('returns mode and only the event areas with active tables', async () => {
      const { controller, device, tablesService } = setup();

      const { data } = await controller.getTables(device());

      expect(tablesService.loadAreas).toHaveBeenCalledWith(ORG, {
        areaIds: ['area-a'],
        activeTablesOnly: true,
      });
      expect(data.mode).toBe('predefined');
      expect(data.eventId).toBe(EVENT);
      expect(data.areas[0]).toEqual(
        expect.objectContaining({ id: 'area-a', name: 'Zelt A', gridSize: 20 }),
      );
      expect(data.areas[0]).not.toHaveProperty('organizationId');
      expect(data.areas[0].tables[0]).toEqual(
        expect.objectContaining({ id: 't1', label: 'A01', seats: 6 }),
      );
      expect(data.areas[0].tables[0]).not.toHaveProperty('organizationId');
    });

    it('defaults to free and no areas without an active event', async () => {
      const { controller, device, tablesService } = setup({ events: [] });
      await expect(controller.getTables(device())).resolves.toEqual({
        data: { eventId: null, mode: 'free', areas: [] },
      });
      expect(tablesService.loadAreas).not.toHaveBeenCalled();
    });

    it('treats a missing tables block as free and loads all areas', async () => {
      const { controller, device, tablesService } = setup({
        events: [
          {
            id: EVENT,
            organizationId: ORG,
            status: EventStatus.TEST,
            settings: {},
          },
        ],
      });
      const { data } = await controller.getTables(device());
      expect(data.mode).toBe('free');
      expect(tablesService.loadAreas).toHaveBeenCalledWith(ORG, {
        areaIds: null,
        activeTablesOnly: true,
      });
    });
  });

  describe('GET tables/status', () => {
    const events: EventRow[] = [
      {
        id: EVENT,
        organizationId: ORG,
        status: EventStatus.TEST,
        settings: {},
      },
      {
        id: OLD_EVENT,
        organizationId: ORG,
        status: EventStatus.INACTIVE,
        settings: {},
      },
      {
        id: FOREIGN_EVENT,
        organizationId: 'org-2',
        status: EventStatus.ACTIVE,
        settings: {},
      },
    ];

    it('uses the active/test event when no eventId is given', async () => {
      const { controller, device, tablesService } = setup({ events });
      await controller.getTableStatus(device());
      expect(tablesService.getStatus).toHaveBeenCalledWith(ORG, EVENT);
    });

    it('rejects inactive and foreign events', async () => {
      const { controller, device, tablesService } = setup({ events });
      await expect(
        controller.getTableStatus(device(), OLD_EVENT),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        controller.getTableStatus(device(), FOREIGN_EVENT),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tablesService.getStatus).not.toHaveBeenCalled();
    });

    it('is empty without an active/test event', async () => {
      const { controller, device } = setup({ events: [events[1]] });
      await expect(controller.getTableStatus(device())).resolves.toEqual({
        data: [],
      });
    });
  });

  describe('POST tables/acknowledge', () => {
    it('only acknowledges open, unacknowledged guest orders of the table', async () => {
      const { controller, device, updates, gatewayService } = setup();

      const { data } = await controller.acknowledgeTable(device(), {
        tableKey: ' a03 ',
      });

      const params = Object.assign(
        {},
        ...updates.where.map((w) => w.params ?? {}),
      ) as Record<string, unknown>;
      expect(params).toMatchObject({
        organizationId: ORG,
        eventId: EVENT,
        key: 'A03',
        sources: ['online', 'qr_order'],
        status: 'open',
      });
      expect(updates.where.map((w) => w.sql)).toContain(
        'acknowledged_at IS NULL',
      );
      expect(data).toEqual({ acknowledged: 1, orderIds: ['guest-1'] });
      expect(gatewayService.notifyOrderUpdated).toHaveBeenCalledWith(
        ORG,
        EVENT,
        'guest-1',
        expect.objectContaining({
          acknowledgedAt: expect.any(Date) as unknown,
        }),
      );
    });
  });

  describe('POST order-items/deliver', () => {
    it('delegates to OrdersService with the device organization', async () => {
      const { controller, device, ordersService } = setup();
      await controller.deliverItems(device(), { itemIds: ['i1', 'i2'] });
      expect(ordersService.deliverItemsForDevice).toHaveBeenCalledWith(ORG, [
        'i1',
        'i2',
      ]);
    });
  });

  describe('GET status', () => {
    const now = Date.now();
    const printers = [
      {
        id: 'p-device',
        organizationId: ORG,
        name: 'Theke',
        isActive: true,
        isOnline: true,
        lastSeenAt: new Date(now - 10_000),
      },
      {
        id: 'p-org',
        organizationId: ORG,
        name: 'Bon',
        isActive: true,
        isOnline: true,
        lastSeenAt: new Date(now - 10_000),
      },
    ];
    const orgSettings = {
      orderFlow: { receiptPrinting: { enabled: true, printerId: 'p-org' } },
    };

    it('prefers the device default printer', async () => {
      const { controller, device } = setup({ printers, orgSettings });
      const { data } = await controller.getStatus(
        device({ defaultPrinterId: 'p-device' }),
      );
      expect(data).toEqual({
        printer: {
          id: 'p-device',
          name: 'Theke',
          isOnline: true,
          lastSeenAt: printers[0].lastSeenAt,
        },
        tse: null,
      });
    });

    it('falls back to the receipt printer of the organization, then none', async () => {
      const { controller, device } = setup({ printers, orgSettings });
      expect((await controller.getStatus(device())).data.printer?.id).toBe(
        'p-org',
      );

      const bare = setup({ printers });
      await expect(bare.controller.getStatus(bare.device())).resolves.toEqual({
        data: { printer: null, tse: null },
      });
    });

    it('ignores printers of other organizations', async () => {
      const { controller, device } = setup({
        printers: [{ ...printers[0], organizationId: 'org-2' }],
      });
      const { data } = await controller.getStatus(
        device({ defaultPrinterId: 'p-device' }),
      );
      expect(data.printer).toBeNull();
    });
  });
});

describe('resolveReceiptPrinterId / printerStatus', () => {
  it('device default → org receipt printer → null', () => {
    const org = { orderFlow: { receiptPrinting: { printerId: 'org-p' } } };
    expect(
      resolveReceiptPrinterId({ defaultPrinterId: 'dev-p' }, org as never),
    ).toBe('dev-p');
    expect(resolveReceiptPrinterId({}, org as never)).toBe('org-p');
    expect(resolveReceiptPrinterId(undefined, undefined)).toBeNull();
  });

  it('reports a printer offline once its agent stopped reporting', () => {
    const now = new Date('2026-10-06T12:00:00Z');
    const base = { id: 'p', name: 'P', isActive: true, isOnline: true };
    const seen = (ms: number) => new Date(now.getTime() - ms);
    expect(
      printerStatus({ ...base, lastSeenAt: seen(1000) }, now).isOnline,
    ).toBe(true);
    expect(
      printerStatus({ ...base, lastSeenAt: seen(PRINTER_STALE_MS + 1) }, now)
        .isOnline,
    ).toBe(false);
    expect(printerStatus({ ...base, lastSeenAt: null }, now).isOnline).toBe(
      false,
    );
    expect(
      printerStatus({ ...base, isOnline: false, lastSeenAt: seen(1000) }, now)
        .isOnline,
    ).toBe(false);
    expect(
      printerStatus({ ...base, isActive: false, lastSeenAt: seen(1000) }, now)
        .isOnline,
    ).toBe(false);
  });
});
