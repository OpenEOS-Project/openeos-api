import { Repository } from 'typeorm';

import { Device } from '../../database/entities/device.entity';
import { Event } from '../../database/entities/event.entity';
import {
  OrderItem,
  OrderItemStatus,
} from '../../database/entities/order-item.entity';
import { Order } from '../../database/entities/order.entity';
import { Organization } from '../../database/entities/organization.entity';
import type { Refund } from '../../database/entities/refund.entity';
import { OrderPrintService } from './order-print.service';
import {
  loadOrderStaff,
  orderStaffPayload,
  personName,
  type RawQueryRunner,
} from './order-staff';
import { PrintJobsService } from './print-jobs.service';
import { PrintRoutingService } from './print-routing.service';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

function runner(rows: unknown[]): RawQueryRunner & { query: jest.Mock } {
  return { query: jest.fn(() => Promise.resolve(rows)) };
}

describe('order staff names (Bedienung / Gerät)', () => {
  it('prefers the person over the device and keeps the device separately', () => {
    expect(
      orderStaffPayload({ userName: 'Markus Maier', deviceName: 'Tablet 3' }),
    ).toEqual({ waiter_name: 'Markus Maier', device_name: 'Tablet 3' });
  });

  it('falls back to the device name when no person is recorded', () => {
    expect(
      orderStaffPayload({ userName: null, deviceName: 'Handy Markus' }),
    ).toEqual({ waiter_name: 'Handy Markus', device_name: 'Handy Markus' });
  });

  it('leaves both empty for online orders', () => {
    expect(orderStaffPayload({ userName: null, deviceName: null })).toEqual({
      waiter_name: null,
      device_name: null,
    });
  });

  it('builds a person name and treats blanks as missing', () => {
    expect(personName({ firstName: ' Markus ', lastName: 'Maier' })).toBe(
      'Markus Maier',
    );
    expect(personName({ firstName: 'Markus', lastName: '' })).toBe('Markus');
    expect(personName({ firstName: ' ', lastName: ' ' })).toBeNull();
    expect(personName(null)).toBeNull();
  });

  it('does not query when the order has no creator', async () => {
    const db = runner([]);
    const staff = await loadOrderStaff(db, {
      organizationId: 'org-1',
      createdByUserId: null,
      createdByDeviceId: null,
    });
    expect(staff).toEqual({ userName: null, deviceName: null });
    expect(db.query).not.toHaveBeenCalled();
    expect(await loadOrderStaff(db, null)).toEqual({
      userName: null,
      deviceName: null,
    });
  });

  it('loads both names with one query scoped to the order organization', async () => {
    const db = runner([{ device_name: ' Handy Markus ', user_name: '  ' }]);
    const staff = await loadOrderStaff(db, {
      organizationId: 'org-1',
      createdByUserId: 'user-1',
      createdByDeviceId: 'dev-1',
    });
    expect(staff).toEqual({ userName: null, deviceName: 'Handy Markus' });
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['org-1', 'dev-1', 'user-1']);
    expect(sql).toContain('d.organization_id = $1');
    expect(sql).toContain('m.organization_id = $1');
  });
});

describe('OrderPrintService prints the waiter on order-based tickets', () => {
  const items = [
    { id: 'i1', productName: 'Bratwurst' },
    { id: 'i2', productName: 'Pommes' },
    { id: 'i3', productName: 'Bier' },
  ].map(
    (it) =>
      ({
        ...it,
        quantity: 1,
        status: OrderItemStatus.PENDING,
        totalPrice: 3,
        taxRate: 19,
        options: { selected: [] },
        depositAmount: 0,
        notes: null,
        kitchenNotes: null,
        productionStationId: null,
        productionStation: null,
      }) as unknown as OrderItem,
  );

  const order = {
    id: 'order-1',
    organizationId: 'org-1',
    orderNumber: 'A-1',
    dailyNumber: 7,
    eventId: null,
    isTest: false,
    createdByDeviceId: 'dev-1',
    createdByUserId: null,
    subtotal: 9,
    total: 9,
    discountAmount: 0,
    paidAmount: 9,
  } as unknown as Order;

  function setup(
    rows: unknown[] | Error,
    orderFlow: Record<string, unknown> = {},
  ) {
    const organization = {
      id: 'org-1',
      name: 'Feuerwehr',
      settings: { orderFlow },
    } as unknown as Organization;
    const query = jest.fn(() =>
      rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows),
    );
    const deviceRepository = {
      query,
      findOne: jest.fn(() => Promise.resolve({ id: 'dev-1', settings: {} })),
    } as unknown as Repository<Device>;
    const createFromWorkflow = jest.fn(() => Promise.resolve({}));
    const service = new OrderPrintService(
      {
        findOne: jest.fn(() => Promise.resolve(organization)),
      } as unknown as Repository<Organization>,
      {
        find: jest.fn(() => Promise.resolve(items)),
      } as unknown as Repository<OrderItem>,
      deviceRepository,
      {
        findOne: jest.fn(() => Promise.resolve(null)),
      } as unknown as Repository<Event>,
      { createFromWorkflow } as unknown as PrintJobsService,
      {
        resolveOrderPrinter: jest.fn(() =>
          Promise.resolve({ printerId: 'printer-1' }),
        ),
        resolveItemPrinter: jest.fn(() =>
          Promise.resolve({ printerId: 'printer-1' }),
        ),
      } as unknown as PrintRoutingService,
    );
    const payloads = () =>
      (createFromWorkflow.mock.calls as unknown as unknown[][]).map(
        (call) => call[5] as Record<string, unknown>,
      );
    return { service, query, payloads };
  }

  const created = {
    order,
    orderId: 'order-1',
    orderNumber: 'A-1',
    total: 9,
    source: 'pos',
  };

  it('looks the names up once for all per-item kitchen tickets and the order ticket', async () => {
    const { service, query, payloads } = setup(
      [{ device_name: 'Handy Markus', user_name: null }],
      {
        kitchenTicketPrinting: { enabled: true, mode: 'per_item' },
        orderTicketPrinting: { enabled: true },
      },
    );

    await service.handleOrderCreated('org-1', created);

    // 3 Kuechenbons + 1 Bestellbon, aber nur eine Abfrage (kein N+1).
    expect(payloads()).toHaveLength(4);
    expect(query).toHaveBeenCalledTimes(1);
    for (const p of payloads()) {
      expect(p.waiter_name).toBe('Handy Markus');
      expect(p.device_name).toBe('Handy Markus');
    }
  });

  it('uses the person who created the order when one is recorded', async () => {
    const { service, payloads } = setup(
      [{ device_name: 'Kasse 1', user_name: 'Markus Maier' }],
      { kitchenTicketPrinting: { enabled: true, mode: 'per_station' } },
    );

    await service.handleOrderCreated('org-1', created);

    expect(payloads()).toHaveLength(1);
    expect(payloads()[0]).toMatchObject({
      waiter_name: 'Markus Maier',
      device_name: 'Kasse 1',
    });
  });

  it('sends empty names for orders without device or person (online)', async () => {
    const { service, query, payloads } = setup([], {
      kitchenTicketPrinting: { enabled: true, mode: 'per_order' },
    });

    await service.handleOrderCreated('org-1', {
      ...created,
      order: { ...order, createdByDeviceId: null } as Order,
    });

    expect(query).not.toHaveBeenCalled();
    expect(payloads()[0]).toMatchObject({
      waiter_name: null,
      device_name: null,
    });
  });

  it('still prints when the name lookup fails', async () => {
    const { service, payloads } = setup(new Error('db down'), {
      kitchenTicketPrinting: { enabled: true, mode: 'per_order' },
    });

    await service.handleOrderCreated('org-1', created);

    expect(payloads()).toHaveLength(1);
    expect(payloads()[0].waiter_name).toBeNull();
  });

  it('adds the names to receipts (only printed if the template asks for it)', async () => {
    const { service, query, payloads } = setup(
      [{ device_name: 'Handy Markus', user_name: null }],
      { receiptPrinting: { enabled: true } },
    );

    await service.handlePaymentReceived('org-1', {
      orderId: 'order-1',
      orderNumber: 'A-1',
      paymentId: 'pay-1',
      amount: 9,
      paymentMethod: 'cash',
      isFullyPaid: true,
      order,
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(payloads()[0].waiter_name).toBe('Handy Markus');
  });

  it('keeps device_name on the refund receipt as the refunding device', async () => {
    const { service, payloads } = setup([
      { device_name: 'Handy Markus', user_name: null },
    ]);

    await service.printRefundReceipt('org-1', {
      refund: {
        id: 'r1',
        refundNumber: 'S-1',
        kind: 'cancellation',
        items: [],
        taxLines: [],
        amount: -3,
        isTest: false,
        createdAt: new Date(),
      } as unknown as Refund,
      order,
      deviceId: 'dev-2',
      deviceName: 'Kasse Theke',
    });

    expect(payloads()[0]).toMatchObject({
      waiter_name: 'Handy Markus',
      device_name: 'Kasse Theke',
    });
  });

  it('names the waiter on cancellation tickets for the kitchen', async () => {
    const { service, query, payloads } = setup(
      [{ device_name: 'Handy Markus', user_name: null }],
      { kitchenTicketPrinting: { enabled: true, mode: 'per_item' } },
    );

    await service.printCancellationTickets('org-1', {
      order,
      items: items.map((item) => ({ item, quantity: 1 })),
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(payloads().length).toBeGreaterThan(0);
    for (const p of payloads()) expect(p.waiter_name).toBe('Handy Markus');
  });
});
