import { Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { Device } from '../../database/entities/device.entity';
import { EventStatus } from '../../database/entities/event.entity';
import { Order } from '../../database/entities/order.entity';
import { OrderItem } from '../../database/entities/order-item.entity';
import { Organization } from '../../database/entities/organization.entity';
import { Payment, PaymentMethod } from '../../database/entities/payment.entity';
import { DeviceApiController } from '../devices/device-api.controller';
import { OrderPrintService } from '../print-jobs/order-print.service';
import { DeviceSplitPaymentDto, SplitPaymentDto } from './dto';
import { planSplitPayment, type SplitOrder } from './split-payment';
import { transactionManager } from './testing/transaction-manager';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

const ORG_ID = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a11';
const ORDER_ID = '0b6a3c2e-1d4f-4a5b-8c7d-9e0f1a2b3c4d';
const ITEM_A = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const ITEM_B = '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a';

function order(overrides: Partial<SplitOrder> = {}): SplitOrder {
  return {
    status: 'open',
    total: 13,
    paidAmount: 0,
    items: [
      {
        id: ITEM_A,
        productName: 'Bier',
        quantity: 2,
        paidQuantity: 0,
        unitPrice: 4.5,
        optionsPrice: 0,
        status: 'pending',
      },
      {
        id: ITEM_B,
        productName: 'Pommes',
        quantity: 1,
        paidQuantity: 0,
        unitPrice: 3.5,
        optionsPrice: 0.5,
        status: 'pending',
      },
    ],
    ...overrides,
  };
}

const reason = (r: string) => ({ response: { reason: r } });

function expectReason(call: () => unknown, expected: string): void {
  let caught: unknown;
  try {
    call();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject(reason(expected));
}

describe('planSplitPayment', () => {
  it('computes the amount from the selected items', () => {
    const plan = planSplitPayment(
      order(),
      [
        { orderItemId: ITEM_A, quantity: 1 },
        { orderItemId: ITEM_B, quantity: 1 },
      ],
      8.5,
    );
    expect(plan.amount).toBe(8.5);
    expect(plan.lines.map((l) => [l.item.id, l.quantity, l.amount])).toEqual([
      [ITEM_A, 1, 4.5],
      [ITEM_B, 1, 4],
    ]);
  });

  it('books the computed amount, not rounding noise from the client', () => {
    const plan = planSplitPayment(
      order(),
      [{ orderItemId: ITEM_A, quantity: 2 }],
      9.000000000000002,
    );
    expect(plan.amount).toBe(9);
  });

  it('rejects an amount that does not match the items', () => {
    expectReason(
      () =>
        planSplitPayment(order(), [{ orderItemId: ITEM_A, quantity: 1 }], -4.5),
      'PAYMENT_AMOUNT_MISMATCH',
    );
    expectReason(
      () =>
        planSplitPayment(order(), [{ orderItemId: ITEM_A, quantity: 1 }], 5),
      'PAYMENT_AMOUNT_MISMATCH',
    );
  });

  it('rejects zero, negative and fractional quantities', () => {
    for (const quantity of [0, -1, 0.5]) {
      expectReason(
        () =>
          planSplitPayment(order(), [{ orderItemId: ITEM_A, quantity }], 4.5),
        'INSUFFICIENT_UNPAID_QUANTITY',
      );
    }
  });

  it('adds up repeated items before checking the unpaid quantity', () => {
    expectReason(
      () =>
        planSplitPayment(
          order(),
          [
            { orderItemId: ITEM_A, quantity: 2 },
            { orderItemId: ITEM_A, quantity: 2 },
          ],
          18,
        ),
      'INSUFFICIENT_UNPAID_QUANTITY',
    );
  });

  it('only pays items of this order that are not cancelled', () => {
    expectReason(
      () =>
        planSplitPayment(
          order(),
          [
            {
              orderItemId: '3e4f5a6b-7c8d-4e9f-0a1b-2c3d4e5f6a7b',
              quantity: 1,
            },
          ],
          4.5,
        ),
      'ORDER_ITEM_NOT_FOUND',
    );

    const withCancelled = order();
    withCancelled.items[1].status = 'cancelled';
    expectReason(
      () =>
        planSplitPayment(
          withCancelled,
          [{ orderItemId: ITEM_B, quantity: 1 }],
          4,
        ),
      'INSUFFICIENT_UNPAID_QUANTITY',
    );
  });

  it('never exceeds the open amount of the order', () => {
    // Rabatt auf der Bestellung: Positionen 13 €, offen nur 10 €.
    expectReason(
      () =>
        planSplitPayment(
          order({ total: 10 }),
          [
            { orderItemId: ITEM_A, quantity: 2 },
            { orderItemId: ITEM_B, quantity: 1 },
          ],
          13,
        ),
      'PAYMENT_EXCEEDS_REMAINING',
    );
    expectReason(
      () =>
        planSplitPayment(
          order({ paidAmount: 9.5 }),
          [{ orderItemId: ITEM_A, quantity: 1 }],
          4.5,
        ),
      'PAYMENT_EXCEEDS_REMAINING',
    );
  });

  it('rejects a selection that adds up to nothing to pay', () => {
    const withCredit = order();
    withCredit.items[1].unitPrice = -9;
    withCredit.items[1].optionsPrice = 0;
    expectReason(
      () =>
        planSplitPayment(
          withCredit,
          [
            { orderItemId: ITEM_A, quantity: 2 },
            { orderItemId: ITEM_B, quantity: 1 },
          ],
          0.01,
        ),
      'PAYMENT_AMOUNT_MISMATCH',
    );
  });

  it('rejects cancelled orders and empty selections', () => {
    expectReason(
      () =>
        planSplitPayment(
          order({ status: 'cancelled' }),
          [{ orderItemId: ITEM_A, quantity: 1 }],
          4.5,
        ),
      'ORDER_CANCELLED_CANNOT_COMPLETE',
    );
    expectReason(
      () => planSplitPayment(order(), [], 0.01),
      'PAYMENT_AMOUNT_MISMATCH',
    );
  });
});

describe('DeviceSplitPaymentDto', () => {
  const valid = {
    orderId: ORDER_ID,
    amount: 4.5,
    paymentMethod: 'cash',
    items: [{ orderItemId: ITEM_A, quantity: 1 }],
    amountReceived: 10,
  };

  async function errors(body: Record<string, unknown>): Promise<string[]> {
    const result = await validate(
      plainToInstance(DeviceSplitPaymentDto, body),
      {
        whitelist: true,
        forbidNonWhitelisted: true,
      },
    );
    const flat = (list: typeof result): string[] =>
      list.flatMap((e) => [e.property, ...flat(e.children ?? [])]);
    return flat(result);
  }

  it('accepts what the till sends', async () => {
    expect(await errors(valid)).toEqual([]);
    expect(await errors({ ...valid, paymentMethod: 'tokens' })).toEqual([]);
  });

  it('rejects negative or zero amounts', async () => {
    expect(await errors({ ...valid, amount: -4.5 })).toContain('amount');
    expect(await errors({ ...valid, amount: 0 })).toContain('amount');
    expect(await errors({ ...valid, amountReceived: -1 })).toContain(
      'amountReceived',
    );
  });

  it('rejects unknown payment methods and malformed items', async () => {
    expect(await errors({ ...valid, paymentMethod: 'barter' })).toContain(
      'paymentMethod',
    );
    expect(await errors({ ...valid, items: [] })).toContain('items');
    expect(
      await errors({
        ...valid,
        items: [{ orderItemId: ITEM_A, quantity: -1 }],
      }),
    ).toContain('quantity');
    expect(
      await errors({
        ...valid,
        items: [{ orderItemId: ITEM_A, quantity: 1.5 }],
      }),
    ).toContain('quantity');
    expect(
      await errors({ ...valid, items: [{ orderItemId: 'x', quantity: 1 }] }),
    ).toContain('orderItemId');
  });

  it('rejects fields the till does not send', async () => {
    expect(await errors({ ...valid, metadata: { refund: true } })).toContain(
      'metadata',
    );
  });

  it('applies the same limits to the admin split payment', async () => {
    const result = await validate(
      plainToInstance(SplitPaymentDto, {
        orderId: ORDER_ID,
        amount: -1,
        paymentMethod: 'cash',
        items: [{ orderItemId: ITEM_A, quantity: 0.5 }],
      }),
    );
    expect(result.map((e) => e.property).sort()).toEqual(['amount', 'items']);
  });
});

describe('POST /device-api/payments/split', () => {
  const device = {
    id: 'device-1',
    organizationId: ORG_ID,
    settings: {},
  } as unknown as Device;

  function setup(current: SplitOrder) {
    const organization = {
      id: ORG_ID,
      country: 'AT',
      operatingMode: 'full',
      operatingModeLegacy: false,
      settings: { currency: 'EUR' },
    } as unknown as Organization;
    const event = { id: 'event-1', status: EventStatus.ACTIVE };
    const orderRepository = {
      findOne: jest.fn(() =>
        Promise.resolve({
          id: ORDER_ID,
          organizationId: ORG_ID,
          eventId: 'event-1',
          orderNumber: 'A-1',
          paymentStatus: 'unpaid',
          ...current,
        } as unknown as Order),
      ),
      save: jest.fn((o: Order) => Promise.resolve(o)),
    };
    const orderItemRepository = {
      save: jest.fn((i: OrderItem) => Promise.resolve(i)),
    };
    const paymentRepository = {
      create: jest.fn((p: Partial<Payment>) => ({ id: 'payment-1', ...p })),
      save: jest.fn((p: Payment) => Promise.resolve(p)),
    };
    const none = undefined as never;
    // Teilzahlung bucht in einer Transaktion ueber dieselben Mocks.
    Object.assign(orderRepository, {
      manager: transactionManager([
        [Order, orderRepository],
        [OrderItem, orderItemRepository],
        [Payment, paymentRepository],
      ]),
    });
    const controller = new DeviceApiController(
      { findOne: jest.fn(() => Promise.resolve(organization)) } as never,
      {
        find: jest.fn(() => Promise.resolve([event])),
        findOne: jest.fn(() => Promise.resolve(event)),
      } as never,
      none,
      none,
      orderRepository as never,
      orderItemRepository as never,
      paymentRepository as never,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      { sendOpenCashDrawer: jest.fn() } as never,
      {
        handlePaymentReceived: jest.fn(() => Promise.resolve()),
      } as unknown as OrderPrintService,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
    );
    return {
      controller,
      orderRepository,
      paymentRepository,
      orderItemRepository,
    };
  }

  it('books the computed amount and the paid quantities', async () => {
    const t = setup(order());
    await t.controller.createSplitPayment(device, {
      orderId: ORDER_ID,
      amount: 4.5,
      paymentMethod: PaymentMethod.CARD,
      items: [{ orderItemId: ITEM_A, quantity: 1 }],
    });
    expect(t.paymentRepository.save).toHaveBeenCalledTimes(1);
    const created = t.paymentRepository.create.mock.calls[0][0];
    expect(created.amount).toBe(4.5);
    expect(t.orderItemRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: ITEM_A, paidQuantity: 1 }),
    );
  });

  it('reads the order with a row lock before booking', async () => {
    const t = setup(order());
    await t.controller.createSplitPayment(device, {
      orderId: ORDER_ID,
      amount: 4.5,
      paymentMethod: PaymentMethod.CARD,
      items: [{ orderItemId: ITEM_A, quantity: 1 }],
    });
    expect(t.orderRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ORDER_ID, organizationId: ORG_ID },
        lock: { mode: 'pessimistic_write' },
      }),
    );
  });

  it('books nothing when the items exceed the open amount', async () => {
    const t = setup(order({ paidAmount: 9.5 }));
    await expect(
      t.controller.createSplitPayment(device, {
        orderId: ORDER_ID,
        amount: 4.5,
        paymentMethod: PaymentMethod.CARD,
        items: [{ orderItemId: ITEM_A, quantity: 1 }],
      }),
    ).rejects.toMatchObject(reason('PAYMENT_EXCEEDS_REMAINING'));
    expect(t.paymentRepository.save).not.toHaveBeenCalled();
    expect(t.orderItemRepository.save).not.toHaveBeenCalled();
  });

  it('books nothing for a negative amount', async () => {
    const t = setup(order());
    await expect(
      t.controller.createSplitPayment(device, {
        orderId: ORDER_ID,
        amount: -4.5,
        paymentMethod: PaymentMethod.CARD,
        items: [{ orderItemId: ITEM_A, quantity: -1 }],
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(t.paymentRepository.save).not.toHaveBeenCalled();
  });
});
