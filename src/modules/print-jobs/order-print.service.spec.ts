import { Repository } from 'typeorm';

import { Device } from '../../database/entities/device.entity';
import { Event } from '../../database/entities/event.entity';
import {
  OrderItem,
  OrderItemStatus,
} from '../../database/entities/order-item.entity';
import { Order } from '../../database/entities/order.entity';
import { Organization } from '../../database/entities/organization.entity';
import { OrderPrintService } from './order-print.service';
import { PrintJobsService } from './print-jobs.service';
import { PrintRoutingService } from './print-routing.service';
import {
  buildReceiptTax,
  cashChange,
  cashReceivedMetadata,
} from './receipt-tax.util';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

type ItemInput = Partial<OrderItem> & {
  totalPrice: number;
  taxRate: number;
};

function item(input: ItemInput): OrderItem {
  return {
    status: OrderItemStatus.PENDING,
    quantity: 1,
    productName: 'Artikel',
    options: { selected: [] },
    depositAmount: 0,
    notes: null,
    ...input,
  } as OrderItem;
}

describe('buildReceiptTax', () => {
  it('breaks mixed 19 % / 7 % orders down per rate (VAT included in gross)', () => {
    const result = buildReceiptTax(
      [
        item({ totalPrice: 11.9, taxRate: 19 }),
        item({ totalPrice: 10.7, taxRate: 7 }),
        item({ totalPrice: 5.35, taxRate: 7 }),
      ],
      0,
      false,
    );

    expect(result.tax_rate).toBeUndefined();
    expect(result.tax_lines).toEqual([
      { rate: 19, net: 10, tax: 1.9, gross: 11.9 },
      { rate: 7, net: 15, tax: 1.05, gross: 16.05 },
    ]);
    expect(result.tax_amount).toBe(2.95);
  });

  it('sets tax_rate when every taxed item shares one rate', () => {
    const result = buildReceiptTax(
      [
        item({ totalPrice: 11.9, taxRate: 19 }),
        // 0 % positions carry no tax and do not make the rate "mixed".
        item({ totalPrice: 3, taxRate: 0 }),
      ],
      0,
      false,
    );

    expect(result.tax_rate).toBe(19);
    expect(result.tax_amount).toBe(1.9);
    expect(result.tax_lines).toHaveLength(1);
  });

  it('accepts decimal columns as strings and ignores cancelled items', () => {
    const result = buildReceiptTax(
      [
        item({ totalPrice: '11.90' as unknown as number, taxRate: 19 }),
        item({
          totalPrice: 100,
          taxRate: 19,
          status: OrderItemStatus.CANCELLED,
        }),
      ],
      0,
      false,
    );

    expect(result.tax_amount).toBe(1.9);
  });

  it('spreads a discount proportionally across the rates', () => {
    const result = buildReceiptTax(
      [
        item({ totalPrice: 11.9, taxRate: 19 }),
        item({ totalPrice: 10.7, taxRate: 7 }),
      ],
      // Half of the 22.60 subtotal.
      11.3,
      false,
    );

    expect(result.tax_lines).toEqual([
      { rate: 19, net: 5, tax: 0.95, gross: 5.95 },
      { rate: 7, net: 5, tax: 0.35, gross: 5.35 },
    ]);
  });

  it('prints no VAT for exempt organizations (and when the flag is unset)', () => {
    const items = [item({ totalPrice: 11.9, taxRate: 19 })];
    expect(buildReceiptTax(items, 0, true)).toEqual({});
    expect(buildReceiptTax(items, 0, undefined)).toEqual({});
  });

  it('prints no VAT when nothing is taxed', () => {
    expect(
      buildReceiptTax([item({ totalPrice: 5, taxRate: 0 })], 0, false),
    ).toEqual({});
  });
});

describe('cash change helpers', () => {
  it('computes change only for cash payments with a larger received amount', () => {
    expect(cashChange('cash', 13.4, 20)).toBe(6.6);
    expect(cashChange('cash', 13.4, 13.4)).toBeUndefined();
    expect(cashChange('card', 13.4, 20)).toBeUndefined();
    expect(cashChange('cash', 13.4, undefined)).toBeUndefined();
    expect(cashChange('cash', 13.4, '20')).toBeUndefined();
  });

  it('stores the received amount only for plausible cash payments', () => {
    expect(cashReceivedMetadata('cash', 13.4, 20)).toEqual({
      amountReceived: 20,
    });
    expect(cashReceivedMetadata('cash', 13.4, 10)).toEqual({});
    expect(cashReceivedMetadata('card', 13.4, 20)).toEqual({});
    expect(cashReceivedMetadata('cash', 13.4, undefined)).toEqual({});
  });
});

describe('OrderPrintService receipt payload', () => {
  function setup(
    vatExempt: boolean | undefined,
    items: OrderItem[],
    extraSettings: Record<string, unknown> = {},
  ) {
    const organization = {
      id: 'org-1',
      name: 'Verein',
      settings: {
        vatExempt,
        orderFlow: { receiptPrinting: { enabled: true } },
        ...extraSettings,
      },
    } as unknown as Organization;
    const organizationRepository = {
      findOne: jest.fn(() => Promise.resolve(organization)),
    } as unknown as Repository<Organization>;
    const orderItemRepository = {
      find: jest.fn(() => Promise.resolve(items)),
    } as unknown as Repository<OrderItem>;
    const eventRepository = {
      findOne: jest.fn(() => Promise.resolve(null)),
    } as unknown as Repository<Event>;
    const createFromWorkflow = jest.fn(() => Promise.resolve({}));
    const printJobsService = {
      createFromWorkflow,
    } as unknown as PrintJobsService;
    const printRoutingService = {
      resolveOrderPrinter: jest.fn(() =>
        Promise.resolve({ printerId: 'printer-1' }),
      ),
    } as unknown as PrintRoutingService;

    const service = new OrderPrintService(
      organizationRepository,
      orderItemRepository,
      {} as Repository<Device>,
      eventRepository,
      printJobsService,
      printRoutingService,
    );
    const payload = () => {
      const calls = createFromWorkflow.mock.calls as unknown as unknown[][];
      return calls[0][5] as Record<string, unknown>;
    };
    return { service, payload };
  }

  const order = {
    id: 'order-1',
    orderNumber: 'A-1',
    eventId: null,
    createdByDeviceId: null,
    subtotal: 22.6,
    discountAmount: 0,
    // 2 x 1.00 Pfand on top of the subtotal.
    pfandTotal: 2,
    total: 24.6,
    paidAmount: 24.6,
  } as unknown as Order;

  const items = [
    item({ totalPrice: 11.9, taxRate: 19 }),
    item({ totalPrice: 10.7, taxRate: 7, quantity: 2, depositAmount: 1 }),
  ];

  it('fills VAT from the items, excluding Pfand, and the cash change', async () => {
    const { service, payload } = setup(false, items);

    await service.handlePaymentReceived('org-1', {
      orderId: 'order-1',
      orderNumber: 'A-1',
      paymentId: 'pay-1',
      amount: 24.6,
      paymentMethod: 'cash',
      isFullyPaid: true,
      order,
      amountReceived: 50,
    });

    const p = payload();
    // 1.90 + 0.70 — the 2.00 Pfand is not part of the taxable amount.
    expect(p.tax_amount).toBe(2.6);
    expect(p.tax_rate).toBeUndefined();
    expect(p.tax_lines).toEqual([
      { rate: 19, net: 10, tax: 1.9, gross: 11.9 },
      { rate: 7, net: 10, tax: 0.7, gross: 10.7 },
    ]);
    expect(p.pfand_total).toBe(2);
    expect(p.change).toBe(25.4);
  });

  it('omits the VAT keys for exempt organizations', async () => {
    const { service, payload } = setup(true, items);

    await service.handlePaymentReceived('org-1', {
      orderId: 'order-1',
      orderNumber: 'A-1',
      paymentId: 'pay-1',
      amount: 24.6,
      paymentMethod: 'card',
      isFullyPaid: true,
      order,
    });

    const p = payload();
    // The printer templates test `tax_amount is defined` — the key must be
    // absent, not 0.
    expect('tax_amount' in p).toBe(false);
    expect('tax_lines' in p).toBe(false);
    expect(p.change).toBeUndefined();
  });

  it('sends a German payment label next to the raw method', async () => {
    const { service, payload } = setup(true, items);
    await service.handlePaymentReceived('org-1', {
      orderId: 'order-1',
      orderNumber: 'A-1',
      paymentId: 'pay-1',
      amount: 24.6,
      paymentMethod: 'cash',
      isFullyPaid: true,
      order,
    });
    const p = payload();
    expect(p.payment_method).toBe('cash');
    expect(p.payment_label).toBe('Bar');
  });

  it('leaves an empty address out of the header instead of printing undefined', async () => {
    const { service, payload } = setup(true, items, {
      address: {},
      contact: { email: 'a@b.de', phone: '  ' },
    });
    await service.handlePaymentReceived('org-1', {
      orderId: 'order-1',
      orderNumber: 'A-1',
      paymentId: 'pay-1',
      amount: 24.6,
      paymentMethod: 'sumup_terminal',
      isFullyPaid: true,
      order,
    });
    const p = payload();
    const organization = JSON.parse(JSON.stringify(p.organization)) as Record<
      string,
      unknown
    >;
    expect(organization).toEqual({ name: 'Verein' });
    expect(JSON.stringify(p)).not.toContain('undefined');
    expect(p.payment_label).toBe('Karte (SumUp)');
  });

  it('prints only the address parts that exist', async () => {
    const { service, payload } = setup(true, items, {
      address: { street: '', zip: '12345', city: 'Musterstadt' },
    });
    await service.handlePaymentReceived('org-1', {
      orderId: 'order-1',
      orderNumber: 'A-1',
      paymentId: 'pay-1',
      amount: 24.6,
      paymentMethod: 'card',
      isFullyPaid: true,
      order,
    });
    expect(payload().organization).toMatchObject({
      address: '12345 Musterstadt',
    });
  });

  it('prints on „Bon drucken“ even when the automatic receipt is off', async () => {
    const { service } = setup(true, items, {
      orderFlow: { receiptPrinting: { enabled: false } },
    });
    const data = {
      orderId: 'order-1',
      orderNumber: 'A-1',
      paymentId: 'pay-1',
      amount: 24.6,
      paymentMethod: 'card',
      isFullyPaid: true,
      order,
    };
    // automatisch: nichts
    await expect(service.handlePaymentReceived('org-1', data)).resolves.toBe(
      false,
    );
    // von Hand: gedruckt
    await expect(
      service.handlePaymentReceived('org-1', { ...data, onDemand: true }),
    ).resolves.toBe(true);
  });

  it('builds the same payload for print and digital receipt', async () => {
    const { service, payload } = setup(false, items);
    const data = {
      orderId: 'order-1',
      orderNumber: 'A-1',
      paymentId: 'pay-1',
      amount: 24.6,
      paymentMethod: 'cash',
      isFullyPaid: true,
      order,
      amountReceived: 50,
    };
    await service.handlePaymentReceived('org-1', data);
    expect(await service.receiptPayload('org-1', data)).toEqual(payload());
  });
});

describe('OrderPrintService receipt payload: tip per payment, service fee', () => {
  /** Zahlungen der Bestellung, wie `payments` sie liefert. */
  function setup(
    payments: Array<{ id: string; tip_amount: string }>,
    vatExempt = false,
  ) {
    const organization = {
      id: 'org-1',
      name: 'Verein',
      settings: {
        vatExempt,
        orderFlow: { receiptPrinting: { enabled: true } },
      },
    } as unknown as Organization;
    const query = jest.fn((sql: string) =>
      Promise.resolve(sql.includes('tip_amount') ? payments : []),
    );
    const organizationRepository = {
      findOne: jest.fn(() => Promise.resolve(organization)),
      manager: { query },
    } as unknown as Repository<Organization>;
    const orderItemRepository = {
      find: jest.fn(() =>
        Promise.resolve([
          item({ id: 'i-1', totalPrice: 11.9, taxRate: 19 }),
          item({ id: 'i-2', totalPrice: 10.7, taxRate: 7 }),
        ]),
      ),
    } as unknown as Repository<OrderItem>;
    const service = new OrderPrintService(
      organizationRepository,
      orderItemRepository,
      {} as Repository<Device>,
      {
        findOne: jest.fn(() => Promise.resolve(null)),
      } as unknown as Repository<Event>,
      {} as PrintJobsService,
      {} as PrintRoutingService,
    );
    return { service };
  }

  const order = (extra: Partial<Order> = {}) =>
    ({
      id: 'order-1',
      orderNumber: 'A-1',
      eventId: null,
      subtotal: 22.6,
      discountAmount: 0,
      pfandTotal: 0,
      tipAmount: 2,
      total: 24.6,
      paidAmount: 24.6,
      paymentStatus: 'paid',
      ...extra,
    }) as unknown as Order;

  const data = (paymentId: string, o: Order) => ({
    orderId: 'order-1',
    orderNumber: 'A-1',
    paymentId,
    amount: 10,
    paymentMethod: 'cash',
    isFullyPaid: true,
    order: o,
  });

  it('split payment: only the partial payment that carried the tip prints it', async () => {
    const { service } = setup([
      { id: 'pay-1', tip_amount: '0.00' },
      { id: 'pay-2', tip_amount: '2.00' },
    ]);

    const first = await service.receiptPayload('org-1', data('pay-1', order()));
    const second = await service.receiptPayload(
      'org-1',
      data('pay-2', order()),
    );

    expect(first.tip_amount).toBe(0);
    expect(second.tip_amount).toBe(2);
    // Steuer ohne Trinkgeld auf dem ersten Teilbeleg: nur die Ware.
    expect(first.tax_amount).toBe(2.6);
    expect(Number(second.tax_amount)).toBeGreaterThan(2.6);
  });

  it('tip only on the order (older data): printed on the payment that completed the order', async () => {
    const { service } = setup([
      { id: 'pay-1', tip_amount: '0.00' },
      { id: 'pay-2', tip_amount: '0.00' },
    ]);

    const first = await service.receiptPayload('org-1', data('pay-1', order()));
    const last = await service.receiptPayload('org-1', data('pay-2', order()));
    const notYetPaid = await service.receiptPayload(
      'org-1',
      data('pay-2', order({ paidAmount: 10, paymentStatus: 'partly_paid' })),
    );

    expect(first.tip_amount).toBe(0);
    expect(last.tip_amount).toBe(2);
    expect(notYetPaid.tip_amount).toBe(0);
  });

  it('single payment keeps the order tip', async () => {
    const { service } = setup([{ id: 'pay-1', tip_amount: '0.00' }]);
    const p = await service.receiptPayload('org-1', data('pay-1', order()));
    expect(p.tip_amount).toBe(2);
  });

  it('shop service fee: own receipt line and its own 19 % VAT line', async () => {
    const { service } = setup([{ id: 'pay-1', tip_amount: '0.00' }]);
    const p = await service.receiptPayload(
      'org-1',
      data(
        'pay-1',
        order({
          tipAmount: 0,
          total: 23.1,
          serviceFee: 0.5,
          serviceFeeTaxRate: 19,
        }),
      ),
    );

    expect(p.service_fee).toBe(0.5);
    // 11,90 + 0,50 zu 19 %, 10,70 zu 7 %.
    expect(p.tax_lines).toEqual([
      { rate: 19, net: 10.42, tax: 1.98, gross: 12.4 },
      { rate: 7, net: 10, tax: 0.7, gross: 10.7 },
    ]);
  });
});
