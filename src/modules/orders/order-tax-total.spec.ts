import {
  OrderItem,
  OrderItemStatus,
} from '../../database/entities/order-item.entity';
import { Order } from '../../database/entities/order.entity';
import { DeviceApiController } from '../devices/device-api.controller';
import { EventsShopCheckoutController } from '../events/events-shop-checkout.controller';
import { buildReceiptTax, orderTaxTotal } from '../print-jobs/receipt-tax.util';
import { OrdersService } from './orders.service';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

function item(
  totalPrice: number,
  taxRate: number,
  extra: Partial<OrderItem> = {},
) {
  return {
    totalPrice,
    taxRate,
    quantity: 1,
    depositAmount: 0,
    status: OrderItemStatus.PENDING,
    ...extra,
  } as OrderItem;
}

describe('orderTaxTotal', () => {
  const items = [item(11.9, 19), item(10.7, 7)];

  it('is the VAT contained in the gross prices', () => {
    // Not 11.90 * 19 % + 10.70 * 7 % = 3.01.
    expect(orderTaxTotal(items, 0, false)).toBe(2.6);
  });

  it('matches the receipt for the same order', () => {
    expect(orderTaxTotal(items, 11.3, false)).toBe(
      buildReceiptTax(items, 11.3, false).tax_amount,
    );
  });

  it('spreads the discount proportionally', () => {
    expect(orderTaxTotal(items, 11.3, false)).toBe(1.3);
  });

  it('is 0 unless the organization is explicitly not VAT-exempt', () => {
    expect(orderTaxTotal(items, 0, true)).toBe(0);
    expect(orderTaxTotal(items, 0, undefined)).toBe(0);
  });
});

/*
 * recalculateOrderTotals exists twice (OrdersService and
 * DeviceApiController). Both must store the same totals.
 */
type Recalc = (this: unknown, ...args: unknown[]) => Promise<void>;
const recalcOf = (prototype: object) =>
  (prototype as { recalculateOrderTotals: Recalc }).recalculateOrderTotals;

describe.each([
  [
    'OrdersService',
    (self: object, _manager: object, id: string) =>
      recalcOf(OrdersService.prototype).call(self, id),
  ],
  [
    // Laeuft in der Transaktion der Bestellanlage (EntityManager).
    'DeviceApiController',
    (self: object, manager: object, id: string, vatExempt?: boolean) =>
      recalcOf(DeviceApiController.prototype).call(
        self,
        manager,
        id,
        vatExempt,
      ),
  ],
])('%s.recalculateOrderTotals', (_name, invoke) => {
  function run(order: Order, vatExempt: boolean | undefined) {
    const saved: Order[] = [];
    const self = {
      orderRepository: {
        findOne: jest.fn(() => Promise.resolve(order)),
        save: jest.fn((o: Order) => {
          saved.push({ ...o } as Order);
          return Promise.resolve(o);
        }),
      },
      organizationRepository: {
        findOne: jest.fn(() =>
          Promise.resolve({ id: 'org-1', settings: { vatExempt } }),
        ),
      },
    };
    const manager = {
      findOne: self.orderRepository.findOne,
      save: self.orderRepository.save,
    };
    return invoke(self, manager, order.id, vatExempt).then(() => saved[0]);
  }

  function order(): Order {
    return {
      id: 'order-1',
      organizationId: 'org-1',
      discountAmount: 2.26,
      tipAmount: 1,
      items: [
        item(11.9, 19),
        // Pfand: 2 x 1.00 on top, not taxable.
        item(10.7, 7, { quantity: 2, depositAmount: 1 }),
        item(50, 19, { status: OrderItemStatus.CANCELLED }),
      ],
    } as unknown as Order;
  }

  it('stores the contained VAT after the discount, excluding Pfand and tip', async () => {
    const saved = await run(order(), false);

    expect(saved.subtotal).toBe(22.6);
    expect(saved.pfandTotal).toBe(2);
    // 10 % discount: 10.71 @ 19 % -> 1.71, 9.63 @ 7 % -> 0.63.
    expect(saved.taxTotal).toBe(2.34);
    expect(saved.total).toBeCloseTo(22.6 - 2.26 + 1 + 2, 2);
  });

  it('stores 0 for VAT-exempt organizations', async () => {
    const saved = await run(order(), true);
    expect(saved.taxTotal).toBe(0);
  });
});

describe('EventsShopCheckoutController.createOrderFromCheckout', () => {
  async function run(vatExempt: boolean | undefined) {
    const savedOrders: Order[] = [];
    const savedItems: OrderItem[][] = [];
    const resolved = <T>(value: T) => jest.fn(() => Promise.resolve(value));
    const self = {
      logger: { error: jest.fn(), warn: jest.fn() },
      productRepository: {
        find: resolved([
          { id: 'p-beer', categoryId: null, taxRate: '19.00' },
          { id: 'p-food', categoryId: null, taxRate: 7 },
        ]),
      },
      categoryRepository: { find: resolved([]) },
      organizationRepository: {
        findOne: resolved({ id: 'org-1', settings: { vatExempt } }),
      },
      orderRepository: {
        // saveOrderWithNumbers: lock + MAX queries, then insert.
        manager: {
          transaction: <T>(work: (manager: unknown) => Promise<T>) =>
            work({
              query: resolved([{ max: null }]),
              findOne: resolved({ id: 'org-1', settings: {} }),
              create: (_entity: unknown, o: Partial<Order>) => ({
                id: 'order-1',
                ...o,
              }),
              save: (o: Order) => Promise.resolve(o),
            }),
        },
        create: (o: Partial<Order>) => ({ id: 'order-1', ...o }),
        save: jest.fn((o: Order) => {
          savedOrders.push({ ...o } as Order);
          return Promise.resolve(o);
        }),
      },
      orderItemRepository: {
        create: (i: Partial<OrderItem>) => i,
        save: jest.fn((items: OrderItem[]) => {
          savedItems.push(items);
          return Promise.resolve(items);
        }),
      },
      paymentRepository: {
        create: (p: object) => ({ id: 'pay-1', ...p }),
        save: jest.fn((p: object) => Promise.resolve(p)),
      },
      orderPrintService: {
        handleOrderCreated: resolved(undefined),
        handlePaymentReceived: resolved(undefined),
      },
    };
    const checkout = {
      organizationId: 'org-1',
      eventId: 'event-1',
      totalAmount: 23.1,
      serviceFee: 0.5,
      currency: 'EUR',
      email: 'gast@example.org',
      items: [
        { productId: 'p-beer', name: 'Bier', quantity: 1, unitPrice: 11.9 },
        { productId: 'p-food', name: 'Wurst', quantity: 1, unitPrice: 10.7 },
      ],
    };
    const create = (
      EventsShopCheckoutController.prototype as unknown as {
        createOrderFromCheckout: (this: unknown, c: unknown) => Promise<Order>;
      }
    ).createOrderFromCheckout;
    const order = await create.call(self, checkout);
    return { order, items: savedItems[0] };
  }

  it('snapshots the product tax rates and stores the contained VAT', async () => {
    const { order, items } = await run(false);

    expect(items.map((i) => i.taxRate)).toEqual([19, 7]);
    // The 0.50 service fee is not an item and stays out of the VAT.
    expect(order.taxTotal).toBe(2.6);
  });

  it('stores 0 for VAT-exempt organizations', async () => {
    const { order } = await run(true);
    expect(order.taxTotal).toBe(0);
  });
});
