import type {
  Order,
  OrderItem,
  PfandReturn,
  Product,
  Refund,
} from '../../database/entities';
import {
  envelope,
  orderData,
  pfandReturnData,
  productData,
  refundData,
} from './webhook-payloads';

const order = {
  id: 'o1',
  orderNumber: 'S-20261110-0001',
  dailyNumber: 1,
  eventId: 'e1',
  status: 'completed',
  paymentStatus: 'paid',
  source: 'online',
  fulfillmentType: 'counter_pickup',
  tableNumber: null,
  isTest: false,
  createdAt: new Date('2026-11-10T18:00:00Z'),
  completedAt: new Date('2026-11-10T18:05:00Z'),
  cancelledAt: null,
  cancellationReason: 'Gast hat sich beschwert (Herr Meier)',
  subtotal: '7.50',
  taxTotal: '1.198',
  total: '7.50',
  paidAmount: '7.50',
  tipAmount: '0',
  discountAmount: '0',
  refundedAmount: '0',
  pfandTotal: '2',
  customerName: 'Max Gast',
  customerPhone: '0170 1234',
  notes: 'Shop-Bestellung · max@gast.example',
  createdByUserId: 'u-cashier',
  createdByDeviceId: 'd1',
} as unknown as Order;

const items = [
  {
    id: 'i2',
    productId: 'p2',
    productName: 'Pommes',
    categoryName: 'Essen',
    quantity: 1,
    unitPrice: '3.00',
    optionsPrice: '0.50',
    totalPrice: '3.50',
    taxRate: '7',
    options: {
      selected: [{ group: 'Soße', option: 'Mayo', priceModifier: 0.5 }],
    },
    status: 'delivered',
    notes: 'extra knusprig für Max',
    sortOrder: 2,
  },
  {
    id: 'i1',
    productId: 'p1',
    productName: 'Apfelschorle',
    categoryName: 'Getränke',
    quantity: 2,
    unitPrice: '2.00',
    optionsPrice: '0',
    totalPrice: '4.00',
    taxRate: '19',
    options: { selected: [] },
    status: 'delivered',
    notes: null,
    sortOrder: 1,
  },
] as unknown as OrderItem[];

describe('webhook payloads', () => {
  it('order: amounts as numbers, items sorted, no staff or free text, no guest data by default', () => {
    const data = orderData(order, items, {
      ordersOnly: false,
      includeGuestData: false,
    });
    expect(data).toMatchObject({
      id: 'o1',
      orderNumber: 'S-20261110-0001',
      status: 'completed',
      paymentStatus: 'paid',
      source: 'online',
      currency: 'EUR',
      createdAt: '2026-11-10T18:00:00.000Z',
      amounts: {
        subtotal: 7.5,
        taxTotal: 1.2,
        total: 7.5,
        paidAmount: 7.5,
        pfandTotal: 2,
      },
    });
    expect(
      (data.items as Array<Record<string, unknown>>).map((i) => i.id),
    ).toEqual(['i1', 'i2']);
    expect((data.items as Array<Record<string, unknown>>)[1]).toEqual({
      id: 'i2',
      productId: 'p2',
      productName: 'Pommes',
      categoryName: 'Essen',
      quantity: 1,
      unitPrice: 3,
      optionsPrice: 0.5,
      totalPrice: 3.5,
      taxRate: 7,
      options: ['Soße: Mayo'],
      status: 'delivered',
    });
    const text = JSON.stringify(data);
    for (const secret of [
      'Max Gast',
      '0170',
      'max@gast',
      'Meier',
      'u-cashier',
      'knusprig',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(data).not.toHaveProperty('guest');
  });

  it('order with „Gästedaten mitsenden“: guest name, phone, notes and item notes', () => {
    const data = orderData(order, items, {
      ordersOnly: false,
      includeGuestData: true,
    });
    expect(data.guest).toEqual({
      name: 'Max Gast',
      phone: '0170 1234',
      notes: 'Shop-Bestellung · max@gast.example',
    });
    expect((data.items as Array<Record<string, unknown>>)[1].notes).toBe(
      'extra knusprig für Max',
    );
  });

  it('order in „Nur Bons“ (orders_only): no amounts, no item prices', () => {
    const data = orderData(order, items, {
      ordersOnly: true,
      includeGuestData: false,
    });
    expect(data.amounts).toBeNull();
    for (const item of data.items as Array<Record<string, unknown>>) {
      expect(item).not.toHaveProperty('unitPrice');
      expect(item).not.toHaveProperty('optionsPrice');
      expect(item).not.toHaveProperty('totalPrice');
      expect(item).not.toHaveProperty('taxRate');
    }
  });

  it('refund: no reason text or cashier, test flag from status', () => {
    const refund = {
      id: 'r1',
      refundNumber: 'S-20261110-0001-E1',
      orderId: 'o1',
      eventId: 'e1',
      kind: 'refund',
      amount: '3.50',
      taxTotal: '0.23',
      pfandAmount: '0',
      tipAmount: '0',
      paymentMethod: 'cash',
      status: 'test',
      reasonCode: 'quality',
      reasonText: 'Pommes kalt, Gast Frau Schulz',
      actorName: 'Kassiererin Anna',
      isTest: false,
      createdAt: new Date('2026-11-10T19:00:00Z'),
      items: [{ productName: 'Pommes', quantity: 1, amount: '3.5' }],
    } as unknown as Refund;
    const data = refundData(refund, { orderNumber: 'S-20261110-0001' });
    expect(data).toMatchObject({
      amount: 3.5,
      isTest: true,
      reasonCode: 'quality',
      orderNumber: 'S-20261110-0001',
    });
    expect(JSON.stringify(data)).not.toMatch(/Schulz|Anna/);
  });

  it('pfand return and product hide amounts in orders_only', () => {
    const pfand = {
      id: 'pr1',
      returnNumber: 'P-1',
      eventId: 'e1',
      totalAmount: '4.00',
      lines: [
        { pfandTypeId: 'pt', name: 'Becher', unitAmount: '2', quantity: 2 },
      ],
      isTest: false,
      createdAt: new Date(),
    } as unknown as PfandReturn;
    expect(
      pfandReturnData(pfand, { ordersOnly: false, includeGuestData: false }),
    ).toMatchObject({
      totalAmount: 4,
      lines: [{ unitAmount: 2, quantity: 2 }],
    });
    expect(
      pfandReturnData(pfand, { ordersOnly: true, includeGuestData: false }),
    ).toMatchObject({
      totalAmount: null,
      lines: [{ unitAmount: null, quantity: 2 }],
    });
    const product = {
      id: 'p1',
      eventId: 'e1',
      categoryId: 'c1',
      name: 'Apfelschorle',
      price: '2.50',
      taxRate: '19.00',
      isActive: true,
      isAvailable: false,
      trackInventory: true,
      stockQuantity: 12,
      deletedAt: null,
    } as unknown as Product;
    expect(
      productData(product, { ordersOnly: false, includeGuestData: false }),
    ).toMatchObject({
      price: 2.5,
      taxRate: 19,
      isAvailable: false,
      deleted: false,
    });
    expect(
      productData(product, { ordersOnly: true, includeGuestData: false }),
    ).not.toHaveProperty('price');
  });

  it('envelope carries id, type, apiVersion, createdAt, organizationId, data', () => {
    expect(
      envelope('evt', 'order.paid', 'org', new Date('2026-11-10T18:00:00Z'), {
        a: 1,
      }),
    ).toEqual({
      id: 'evt',
      type: 'order.paid',
      apiVersion: '2026-11-10',
      createdAt: '2026-11-10T18:00:00.000Z',
      organizationId: 'org',
      data: { a: 1 },
    });
  });
});
