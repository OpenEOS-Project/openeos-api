import { Logger } from '@nestjs/common';

import { EventStatus } from '../../database/entities/event.entity';
import { PaymentMethod } from '../../database/entities/payment.entity';
import { ShopCheckoutStatus } from '../../database/entities/shop-checkout.entity';
import type { TseReceiptView } from '../tse/tse-view';
import { EventsShopCheckoutController } from './events-shop-checkout.controller';

/*
 * Online-Vorkasse im Shop mit Cloud-TSE (Steuerberater 2026-11-10, Frage
 * 20: Vereine mit TSE signieren alles): die bezahlte Shop-Bestellung wird
 * nach dem Speichern als Kassenbeleg signiert — vor Kuechen- und
 * Kassenbon, und nur von dem Aufruf, der die Bestellung anlegt (Rueckkehr-
 * seite und Webhook koennen beide abrechnen).
 */

let mockOrderCount = 0;
jest.mock('../orders/order-numbering', () => ({
  saveOrderWithNumbers: jest.fn(
    (
      _repo: unknown,
      params: { organizationId: string; eventId: string },
      data: Record<string, unknown>,
    ) =>
      Promise.resolve({
        id: `order-${++mockOrderCount}`,
        orderNumber: `S-20261110-000${mockOrderCount}`,
        dailyNumber: mockOrderCount,
        organizationId: params.organizationId,
        eventId: params.eventId,
        ...data,
      }),
  ),
}));

const ORG_ID = '5d1c7f3e-2b8a-4e6d-9c1f-7a2b3c4d5e6f';
const EVENT_ID = '0b9e2a8c-6a0f-4f53-9d3a-3a4f1c2b7e10';
const CHECKOUT_ID = '3f0b6a52-1c4e-4b8a-9a77-1d2e3f4a5b6c';

const SIGNED: TseReceiptView = {
  id: 'tx-1',
  kind: 'receipt',
  status: 'signed',
  processType: 'Kassenbeleg-V1',
  processData: 'Beleg^9.00_0.00_0.00_0.00_0.00^9.00:Unbar',
} as unknown as TseReceiptView;

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

function setup(options: { tse?: 'active' | 'inactive' | 'none' } = {}) {
  const calls: string[] = [];
  const state = {
    id: CHECKOUT_ID,
    organizationId: ORG_ID,
    eventId: EVENT_ID,
    status: ShopCheckoutStatus.PENDING,
    sumupCheckoutId: 'sumup-chk-1',
    sumupCheckoutUrl: 'https://pay.sumup.example/chk-1',
    email: 'gast@example.org',
    customerName: { firstName: 'Max', lastName: 'Muster' },
    fulfillmentType: 'counter_pickup',
    tableNumber: null,
    currency: 'EUR',
    totalAmount: 9,
    serviceFee: 0,
    orderId: null as string | null,
    paidAt: null as Date | null,
    items: [
      { productId: 'p1', name: 'Bratwurst', quantity: 2, unitPrice: 4.5 },
    ],
  };
  const shopCheckoutRepository = {
    findOne: jest.fn(() => Promise.resolve({ ...state })),
    update: jest.fn(
      (
        where: { id: string; status?: string },
        patch: Partial<typeof state>,
      ) => {
        if (where.status && where.status !== String(state.status)) {
          return Promise.resolve({ affected: 0 });
        }
        Object.assign(state, patch);
        return Promise.resolve({ affected: 1 });
      },
    ),
    save: jest.fn(),
  };
  const organization = {
    id: ORG_ID,
    name: 'TSV Musterstadt',
    country: 'DE',
    operatingMode: 'full',
    tseActive: true,
    settings: {
      vatExempt: false,
      sumup: { apiKey: 'sup_sk_test' },
      integrations: { sumup: { enabled: true } },
    },
  };
  const organizationRepository = {
    findOne: jest.fn(() => Promise.resolve(organization)),
  };
  const eventRepository = {
    findOne: jest.fn(() =>
      Promise.resolve({
        id: EVENT_ID,
        name: 'Sommerfest',
        status: EventStatus.ACTIVE,
      }),
    ),
  };
  const productRepository = {
    find: jest.fn(() =>
      Promise.resolve([
        { id: 'p1', categoryId: 'c1', taxRate: 19, productionStationId: null },
      ]),
    ),
  };
  const categoryRepository = {
    find: jest.fn(() => Promise.resolve([{ id: 'c1', name: 'Essen' }])),
  };
  const orderRepository = {
    save: jest.fn((o: unknown) => Promise.resolve(o)),
    findOne: jest.fn(() =>
      Promise.resolve({ id: state.orderId, orderNumber: 'S-x' }),
    ),
    manager: {},
  };
  const orderItemRepository = {
    create: jest.fn((x: Record<string, unknown>) => ({ ...x })),
    save: jest.fn((x: unknown) => {
      calls.push('orderItems.save');
      return Promise.resolve(x);
    }),
  };
  let paymentCount = 0;
  const paymentRepository = {
    create: jest.fn((x: Record<string, unknown>) => ({ ...x })),
    save: jest.fn((p: Record<string, unknown>) => {
      calls.push('payment.save');
      p.id = `pay-${++paymentCount}`;
      return Promise.resolve(p);
    }),
  };
  const print = {
    handleOrderCreated: jest.fn(() => {
      calls.push('print.kitchen');
      return Promise.resolve();
    }),
    handlePaymentReceived: jest.fn(() => {
      calls.push('print.receipt');
      return Promise.resolve();
    }),
  };
  const email = {
    sendShopOrderConfirmationEmail: jest.fn(() => Promise.resolve()),
  };
  const gateway = { notifyOrderCreated: jest.fn() };
  const tseSigning = {
    isActive: jest.fn(() => Promise.resolve(options.tse !== 'inactive')),
    signPayment: jest.fn(() => {
      calls.push('tse.signPayment');
      return Promise.resolve(SIGNED);
    }),
  };
  // Checkout mit Bestellung speichern (Abschluss der Abrechnung).
  shopCheckoutRepository.save.mockImplementation((row: typeof state) => {
    calls.push('checkout.save');
    Object.assign(state, row);
    return Promise.resolve(row);
  });

  const controller = new EventsShopCheckoutController(
    eventRepository as never,
    organizationRepository as never,
    productRepository as never,
    categoryRepository as never,
    orderRepository as never,
    orderItemRepository as never,
    paymentRepository as never,
    shopCheckoutRepository as never,
    {} as never,
    email as never,
    print as never,
    { get: jest.fn((_k: string, fallback: unknown) => fallback) } as never,
    gateway as never,
    undefined,
    options.tse === 'none' ? undefined : (tseSigning as never),
  );

  // SumUp meldet den Checkout als bezahlt.
  jest.spyOn(global, 'fetch').mockImplementation(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ status: 'PAID' }),
    } as Response),
  );

  return {
    controller,
    calls,
    state,
    print,
    tseSigning,
    paymentRepository,
  };
}

describe('Shop checkout settlement with Cloud-TSE', () => {
  it('signs the online payment after commit and before kitchen ticket and receipt', async () => {
    const { controller, calls, print, tseSigning, paymentRepository } = setup();

    const result = await controller.verifyCheckout(CHECKOUT_ID);

    expect(result.data.status).toBe('paid');
    expect(paymentRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentMethod: PaymentMethod.SUMUP_ONLINE,
        status: 'captured',
        providerTransactionId: 'sumup-chk-1',
      }),
    );
    expect(tseSigning.signPayment).toHaveBeenCalledTimes(1);
    expect(tseSigning.signPayment).toHaveBeenCalledWith('pay-1');
    // Zahlung und Checkout gespeichert → signiert → gedruckt.
    expect(calls).toEqual([
      'orderItems.save',
      'payment.save',
      'checkout.save',
      'tse.signPayment',
      'print.kitchen',
      'print.receipt',
    ]);
    expect(print.handlePaymentReceived).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({
        paymentId: 'pay-1',
        paymentMethod: 'online',
        isFullyPaid: true,
        tse: SIGNED,
      }),
    );
  });

  it('settles only once: return page + webhook (also concurrently) sign a single receipt', async () => {
    const { controller, tseSigning, paymentRepository, print, state } = setup();

    await Promise.all([
      controller.verifyCheckout(CHECKOUT_ID),
      controller.checkoutWebhook(CHECKOUT_ID),
    ]);
    await controller.verifyCheckout(CHECKOUT_ID);
    await controller.checkoutWebhook(CHECKOUT_ID);

    expect(state.status).toBe(ShopCheckoutStatus.PAID);
    expect(paymentRepository.save).toHaveBeenCalledTimes(1);
    expect(tseSigning.signPayment).toHaveBeenCalledTimes(1);
    expect(print.handlePaymentReceived).toHaveBeenCalledTimes(1);
  });

  it('organisation without active TSE: nothing is signed, receipt without TSE block', async () => {
    const { controller, tseSigning, print, calls } = setup({
      tse: 'inactive',
    });

    await controller.verifyCheckout(CHECKOUT_ID);

    expect(tseSigning.isActive).toHaveBeenCalledWith(ORG_ID);
    expect(tseSigning.signPayment).not.toHaveBeenCalled();
    expect(calls).not.toContain('tse.signPayment');
    expect(print.handlePaymentReceived).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({ tse: null }),
    );
  });

  it('works without the TSE module (self-built tests, no provider)', async () => {
    const { controller, print } = setup({ tse: 'none' });

    await controller.verifyCheckout(CHECKOUT_ID);

    expect(print.handleOrderCreated).toHaveBeenCalledTimes(1);
    expect(print.handlePaymentReceived).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({ tse: null }),
    );
  });

  it('a TSE outage never blocks the sale: the failed view goes onto the receipt', async () => {
    const { controller, tseSigning, print } = setup();
    const failedView = {
      ...SIGNED,
      status: 'failed',
      notice: 'TSE ausgefallen',
    } as TseReceiptView;
    tseSigning.signPayment.mockImplementation(() =>
      Promise.resolve(failedView),
    );

    const result = await controller.verifyCheckout(CHECKOUT_ID);

    expect(result.data.status).toBe('paid');
    expect(print.handlePaymentReceived).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({ tse: failedView }),
    );
  });
});
