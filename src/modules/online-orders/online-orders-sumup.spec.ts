import { Logger, NotFoundException } from '@nestjs/common';

import { OnlineOrderSession } from '../../database/entities/online-order-session.entity';
import {
  PaymentMethod,
  PaymentProvider,
  PaymentTransactionStatus,
} from '../../database/entities/payment.entity';
import { SumUpApiService } from '../sumup/sumup-api.service';
import { SumUpService } from '../sumup/sumup.service';
import type { TseReceiptView } from '../tse/tse-view';
import { OnlinePaymentMethod } from './dto';
import {
  OnlineOrdersService,
  qrCheckoutReference,
} from './online-orders.service';

/*
 * QR-Bestellung am Tisch mit SumUp Online, Google Pay oder Apple Pay.
 * Frueher blieb die Zahlung `pending`: ohne Webhook, ohne Nachfrage bei
 * SumUp wurde nie gebucht, signiert oder gedruckt. Jetzt meldet SumUp an
 * den Webhook der Zahlung; Webhook, Rueckkehrseite (pay/confirm),
 * Statusabfrage und Abgleich sehen bei SumUp nach und buchen genau einmal.
 * SumUp ist hier per `fetch` nachgebaut (HTTP des Anbieters).
 */

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

const ORG_ID = 'org-1';
const SIGNED = {
  id: 'tx-1',
  kind: 'receipt',
  status: 'signed',
  processType: 'Kassenbeleg-V1',
  processData: 'Beleg^0.00_12.00_0.00_0.00_0.00^12.00:Unbar',
} as unknown as TseReceiptView;

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

/** Nachgebauter SumUp: POST /v0.1/checkouts und GET /v0.1/checkouts/:id. */
function fakeSumUp() {
  const state = {
    status: 'PENDING',
    amount: 12,
    currency: 'EUR',
    reference: null as string | null,
    created: [] as Array<Record<string, unknown>>,
    lookups: 0,
    down: false,
  };
  const spy = jest
    .spyOn(global, 'fetch')
    .mockImplementation((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (state.down) return Promise.reject(new Error('ECONNREFUSED'));
      if (init?.method === 'POST' && url.endsWith('/v0.1/checkouts')) {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        state.created.push(body);
        state.reference = String(body.checkout_reference);
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () =>
            Promise.resolve({
              id: 'chk-1',
              hosted_checkout_url: 'https://checkout.sumup.example/chk-1',
            }),
        } as Response);
      }
      if (url.includes('/v0.1/checkouts/')) {
        state.lookups += 1;
        const id = decodeURIComponent(url.split('/v0.1/checkouts/')[1]);
        if (id !== 'chk-1') {
          return Promise.resolve({ ok: false, status: 404 } as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              id: 'chk-1',
              status: state.status,
              amount: state.amount,
              currency: state.currency,
              checkout_reference: state.reference,
              transactions:
                state.status === 'PAID'
                  ? [
                      {
                        id: 'trx-9',
                        transaction_code: 'TCODE9',
                        status: 'SUCCESSFUL',
                      },
                    ]
                  : [],
            }),
        } as Response);
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
  return { state, spy };
}

function setup() {
  const calls: string[] = [];
  const session = new OnlineOrderSession();
  Object.assign(session, {
    id: 'session-1',
    organizationId: ORG_ID,
    eventId: 'event-1',
    status: 'ordering',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    organization: {
      id: ORG_ID,
      country: 'DE',
      operatingMode: 'cashless',
      settings: {},
    },
  });
  const order = {
    id: 'order-1',
    organizationId: ORG_ID,
    eventId: 'event-1',
    onlineSessionId: 'session-1',
    orderNumber: '20261111-0003',
    dailyNumber: 3,
    tableNumber: '7',
    total: 12,
    paidAmount: 0,
    paymentStatus: 'unpaid',
    source: 'qr_order',
  };
  const payments = new Map<string, Record<string, unknown>>();
  const organization = {
    id: ORG_ID,
    country: 'DE',
    operatingMode: 'cashless',
    settings: {
      sumup: { apiKey: 'sup_sk_test', merchantCode: 'MCODE' },
      integrations: { sumup: { enabled: true } },
    },
  };
  const sessionRepository = {
    findOne: jest.fn(() => Promise.resolve(session)),
    save: jest.fn((s: unknown) => Promise.resolve(s)),
  };
  const paymentRepository = {
    create: jest.fn((p: Record<string, unknown>) => ({ ...p })),
    save: jest.fn((p: Record<string, unknown>) => {
      payments.set(String(p.id), { ...p });
      return Promise.resolve(p);
    }),
    findOne: jest.fn(({ where }: { where: { id: string } }) => {
      const p = payments.get(where.id);
      return Promise.resolve(p ? { ...p, order: { ...order } } : null);
    }),
    find: jest.fn(() =>
      Promise.resolve(
        [...payments.values()]
          .filter((p) => p.status === PaymentTransactionStatus.PENDING)
          .map((p) => ({ ...p, order: { ...order } })),
      ),
    ),
    // Atomarer Wechsel wie in Postgres: nur aus dem erwarteten Stand.
    update: jest.fn(
      (
        where: { id: string; status: string },
        patch: Record<string, unknown>,
      ) => {
        const p = payments.get(where.id);
        if (!p || p.status !== where.status) {
          return Promise.resolve({ affected: 0 });
        }
        Object.assign(p, patch);
        calls.push(`payment.${String(patch.status)}`);
        return Promise.resolve({ affected: 1 });
      },
    ),
  };
  const orderRepository = {
    findOne: jest.fn(() => Promise.resolve({ ...order })),
    find: jest.fn(() => Promise.resolve([{ ...order, items: [] }])),
    save: jest.fn((o: typeof order) => {
      Object.assign(order, o);
      calls.push('order.save');
      return Promise.resolve(o);
    }),
  };
  const organizationRepository = {
    findOne: jest.fn(() => Promise.resolve(organization)),
  };
  const config = {
    get: jest.fn((key: string) =>
      key === 'API_PUBLIC_URL'
        ? 'https://api.example.org/'
        : key === 'FRONTEND_URL'
          ? 'https://order.example.org'
          : undefined,
    ),
  };
  const sumUp = new SumUpService(
    organizationRepository as never,
    {} as never,
    new SumUpApiService(),
    config as never,
    {} as never,
  );
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
  const gateway = {
    notifyPaymentReceived: jest.fn(() => calls.push('gateway.paid')),
  };
  const tseSigning = {
    isActive: jest.fn(() => Promise.resolve(true)),
    signPayment: jest.fn(() => {
      calls.push('tse.signPayment');
      return Promise.resolve(SIGNED);
    }),
  };
  const none = undefined as never;
  const svc = new OnlineOrdersService(
    sessionRepository as never,
    none,
    none,
    none,
    orderRepository as never,
    none,
    organizationRepository as never,
    paymentRepository as never,
    { captureOrder: jest.fn(), createOrder: jest.fn() } as never,
    sumUp,
    config as never,
    print as never,
    gateway as never,
    undefined,
    tseSigning as never,
  );
  return {
    svc,
    calls,
    order,
    payments,
    print,
    gateway,
    tseSigning,
    paymentRepository,
  };
}

async function startPayment(
  ctx: ReturnType<typeof setup>,
  method = OnlinePaymentMethod.SUMUP_ONLINE,
) {
  const result = (await ctx.svc.initiatePayment('sess_1', {
    paymentMethod: method,
    returnUrl: 'https://order.example.org/status',
  })) as { data: { paymentId: string; checkoutUrl: string } };
  return result.data;
}

describe('QR order payment via SumUp Online / Google Pay / Apple Pay', () => {
  let sumup: ReturnType<typeof fakeSumUp>;
  beforeEach(() => {
    sumup = fakeSumUp();
  });
  afterEach(() => sumup.spy.mockRestore());

  it('creates the checkout with the payment webhook as return_url and the guest page as redirect_url', async () => {
    const ctx = setup();
    const data = await startPayment(ctx);

    expect(data.checkoutUrl).toBe('https://checkout.sumup.example/chk-1');
    expect(sumup.state.created).toEqual([
      expect.objectContaining({
        amount: 12,
        currency: 'EUR',
        merchant_code: 'MCODE',
        return_url: `https://api.example.org/api/public/order/pay/${data.paymentId}/webhook`,
        redirect_url: 'https://order.example.org/status',
        checkout_reference: qrCheckoutReference(data.paymentId),
      }),
    ]);
    expect(ctx.payments.get(data.paymentId)).toMatchObject({
      id: data.paymentId,
      status: PaymentTransactionStatus.PENDING,
      paymentMethod: PaymentMethod.SUMUP_ONLINE,
      providerTransactionId: 'chk-1',
    });
  });

  it('webhook: SumUp confirms PAID → booked, order paid, TSE-signed before kitchen ticket and receipt', async () => {
    const ctx = setup();
    const { paymentId } = await startPayment(ctx);
    sumup.state.status = 'PAID';

    await ctx.svc.handleSumUpWebhook(paymentId);

    expect(ctx.payments.get(paymentId)).toMatchObject({
      status: PaymentTransactionStatus.CAPTURED,
    });
    expect(ctx.payments.get(paymentId)?.metadata).toMatchObject({
      checkoutId: 'chk-1',
      transactionCode: 'TCODE9',
      transactionId: 'trx-9',
    });
    expect(ctx.order).toMatchObject({ paidAmount: 12, paymentStatus: 'paid' });
    expect(ctx.tseSigning.signPayment).toHaveBeenCalledWith(paymentId);
    expect(ctx.calls).toEqual([
      'payment.captured',
      'order.save',
      'tse.signPayment',
      'gateway.paid',
      'print.kitchen',
      'print.receipt',
    ]);
    expect(ctx.print.handlePaymentReceived).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({
        paymentId,
        isFullyPaid: true,
        tse: SIGNED,
      }),
    );
  });

  it('webhook, return page and status poll at the same time book exactly once', async () => {
    const ctx = setup();
    const { paymentId } = await startPayment(ctx);
    sumup.state.status = 'PAID';

    const results = await Promise.all([
      ctx.svc.handleSumUpWebhook(paymentId),
      ctx.svc.confirmPayment('sess_1', paymentId),
      ctx.svc.getOrderStatus('sess_1'),
      ctx.svc.confirmPayment('sess_1', paymentId),
    ]);
    // Nachzuegler: schon gebucht.
    const late = await ctx.svc.confirmPayment('sess_1', paymentId);

    expect(ctx.tseSigning.signPayment).toHaveBeenCalledTimes(1);
    expect(ctx.print.handlePaymentReceived).toHaveBeenCalledTimes(1);
    expect(ctx.print.handleOrderCreated).toHaveBeenCalledTimes(1);
    expect(ctx.order.paidAmount).toBe(12);
    expect([results[1], results[3]].map((r) => r.data.status)).toEqual([
      PaymentTransactionStatus.CAPTURED,
      PaymentTransactionStatus.CAPTURED,
    ]);
    expect(late.data.status).toBe('already_captured');
  });

  it('return page before SumUp settled: stays pending, nothing booked; later poll books it', async () => {
    const ctx = setup();
    const { paymentId } = await startPayment(ctx);

    const early = await ctx.svc.confirmPayment('sess_1', paymentId);
    expect(early.data.status).toBe(PaymentTransactionStatus.PENDING);
    expect(ctx.tseSigning.signPayment).not.toHaveBeenCalled();
    expect(ctx.print.handleOrderCreated).not.toHaveBeenCalled();

    sumup.state.status = 'PAID';
    await ctx.svc.getOrderStatus('sess_1');
    expect(ctx.payments.get(paymentId)?.status).toBe(
      PaymentTransactionStatus.CAPTURED,
    );
    expect(ctx.tseSigning.signPayment).toHaveBeenCalledTimes(1);
  });

  it('status poll asks SumUp at most every few seconds per payment', async () => {
    const ctx = setup();
    await startPayment(ctx);

    await ctx.svc.getOrderStatus('sess_1');
    await ctx.svc.getOrderStatus('sess_1');
    await ctx.svc.getOrderStatus('sess_1');
    expect(sumup.state.lookups).toBe(1);
  });

  it('SumUp says FAILED / EXPIRED → payment failed, nothing booked', async () => {
    for (const status of ['FAILED', 'EXPIRED']) {
      const ctx = setup();
      const { paymentId } = await startPayment(ctx);
      sumup.state.status = status;

      const result = await ctx.svc.confirmPayment('sess_1', paymentId);

      expect(result.data.status).toBe(PaymentTransactionStatus.FAILED);
      expect(ctx.order.paymentStatus).toBe('unpaid');
      expect(ctx.tseSigning.signPayment).not.toHaveBeenCalled();
      expect(ctx.print.handlePaymentReceived).not.toHaveBeenCalled();
    }
  });

  it('PAID with a different amount or reference is never booked', async () => {
    const ctx = setup();
    const { paymentId } = await startPayment(ctx);
    sumup.state.status = 'PAID';
    sumup.state.amount = 1;

    await ctx.svc.handleSumUpWebhook(paymentId);
    expect(ctx.payments.get(paymentId)?.status).toBe(
      PaymentTransactionStatus.PENDING,
    );

    sumup.state.amount = 12;
    sumup.state.reference = 'openeos-qr-someone-else';
    await ctx.svc.handleSumUpWebhook(paymentId);
    expect(ctx.payments.get(paymentId)?.status).toBe(
      PaymentTransactionStatus.PENDING,
    );
    expect(ctx.tseSigning.signPayment).not.toHaveBeenCalled();
  });

  it('SumUp unreachable: webhook answers without throwing, payment stays pending', async () => {
    const ctx = setup();
    const { paymentId } = await startPayment(ctx);
    sumup.state.down = true;

    await expect(ctx.svc.handleSumUpWebhook(paymentId)).resolves.toBe(
      undefined,
    );
    expect(ctx.payments.get(paymentId)?.status).toBe(
      PaymentTransactionStatus.PENDING,
    );
  });

  it('webhook for an unknown payment is ignored', async () => {
    const ctx = setup();
    await expect(
      ctx.svc.handleSumUpWebhook('00000000-0000-4000-8000-000000000000'),
    ).resolves.toBe(undefined);
    expect(sumup.state.lookups).toBe(0);
  });

  it.each([
    [OnlinePaymentMethod.GOOGLE_PAY, PaymentMethod.GOOGLE_PAY],
    [OnlinePaymentMethod.APPLE_PAY, PaymentMethod.APPLE_PAY],
  ])(
    '%s goes the same way and keeps its payment method',
    async (method, stored) => {
      const ctx = setup();
      const { paymentId } = await startPayment(ctx, method);
      sumup.state.status = 'PAID';

      await ctx.svc.handleSumUpWebhook(paymentId);

      expect(ctx.payments.get(paymentId)).toMatchObject({
        status: PaymentTransactionStatus.CAPTURED,
        paymentMethod: stored,
      });
      expect(ctx.tseSigning.signPayment).toHaveBeenCalledWith(paymentId);
    },
  );

  it('reconcile job books a paid payment whose webhook never arrived', async () => {
    const ctx = setup();
    const { paymentId } = await startPayment(ctx);
    sumup.state.status = 'PAID';
    const qb = {
      innerJoinAndSelect: () => qb,
      where: () => qb,
      andWhere: () => qb,
      orderBy: () => qb,
      take: () => qb,
      getMany: () =>
        Promise.resolve([
          { ...ctx.payments.get(paymentId), order: { ...ctx.order } },
        ]),
    };
    Object.assign(ctx.paymentRepository, {
      createQueryBuilder: jest.fn(() => qb),
    });

    await ctx.svc.reconcilePendingSumUpPayments();

    expect(ctx.payments.get(paymentId)?.status).toBe(
      PaymentTransactionStatus.CAPTURED,
    );
    expect(ctx.tseSigning.signPayment).toHaveBeenCalledTimes(1);
  });
});

describe('QR order payment (PayPal) confirmation', () => {
  it('rejects capturing a PayPal order other than the one created for the payment', async () => {
    const ctx = setup();
    ctx.payments.set('pay-pp', {
      id: 'pay-pp',
      orderId: 'order-1',
      amount: 12,
      paymentMethod: PaymentMethod.PAYPAL,
      paymentProvider: PaymentProvider.PAYPAL,
      status: PaymentTransactionStatus.PENDING,
      providerTransactionId: 'PAYPAL-OWN',
    });

    await expect(
      ctx.svc.confirmPayment('sess_1', 'pay-pp', 'PAYPAL-FOREIGN'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(ctx.tseSigning.signPayment).not.toHaveBeenCalled();
  });
});
