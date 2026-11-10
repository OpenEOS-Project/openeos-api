import { ForbiddenException, Logger } from '@nestjs/common';
import type { Repository } from 'typeorm';

import { OnlineOrderSession } from '../../database/entities/online-order-session.entity';
import {
  PaymentProvider,
  PaymentTransactionStatus,
} from '../../database/entities/payment.entity';
import type { TseReceiptView } from '../tse/tse-view';
import { OnlinePaymentMethod } from './dto';
import { OnlineOrdersService } from './online-orders.service';

/*
 * QR-Bestellung am Tisch mit PayPal (Steuerberater 2026-11-10, Frage 20):
 * mit aktiver Cloud-TSE wird die erfasste Zahlung nach dem Speichern als
 * Kassenbeleg signiert — vor Kuechen- und Kassenbon, genau einmal.
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
  processData: 'Beleg^12.00_0.00_0.00_0.00_0.00^12.00:Unbar',
} as unknown as TseReceiptView;

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

function session(operatingMode = 'full') {
  const s = new OnlineOrderSession();
  Object.assign(s, {
    id: 'session-1',
    organizationId: ORG_ID,
    eventId: 'event-1',
    status: 'active',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    organization: { id: ORG_ID, country: 'DE', operatingMode, settings: {} },
  });
  return s;
}

function setup(options: { tse?: boolean; operatingMode?: string } = {}) {
  const calls: string[] = [];
  const current = session(options.operatingMode);
  const order = {
    id: 'order-1',
    organizationId: ORG_ID,
    onlineSessionId: 'session-1',
    orderNumber: '20261110-0007',
    tableNumber: '12',
    total: 12,
    paidAmount: 0,
    paymentStatus: 'unpaid',
    source: 'qr_order',
  };
  const payment = {
    id: 'pay-1',
    orderId: 'order-1',
    amount: 12,
    paymentMethod: 'paypal',
    paymentProvider: PaymentProvider.PAYPAL,
    status: PaymentTransactionStatus.PENDING as PaymentTransactionStatus,
    providerTransactionId: 'PAYPAL-ORDER-1',
    order,
  };
  const sessionRepository = {
    findOne: jest.fn(() => Promise.resolve(current)),
    save: jest.fn((s: OnlineOrderSession) => Promise.resolve(s)),
  } as unknown as Repository<OnlineOrderSession>;
  const paymentRepository = {
    findOne: jest.fn(() => Promise.resolve({ ...payment, order })),
    update: jest.fn(
      (where: { id: string; status: string }, patch: { status: string }) => {
        calls.push('payment.capture');
        if (where.status !== String(payment.status)) {
          return Promise.resolve({ affected: 0 });
        }
        payment.status = patch.status as PaymentTransactionStatus;
        return Promise.resolve({ affected: 1 });
      },
    ),
    save: jest.fn((p: unknown) => Promise.resolve(p)),
    create: jest.fn((p: Record<string, unknown>) => ({ id: 'pay-2', ...p })),
  };
  const orderRepository = {
    save: jest.fn((o: unknown) => {
      calls.push('order.save');
      return Promise.resolve(o);
    }),
    findOne: jest.fn(() => Promise.resolve(order)),
  };
  const organizationRepository = {
    findOne: jest.fn(() =>
      Promise.resolve({
        id: ORG_ID,
        country: 'DE',
        operatingMode: options.operatingMode ?? 'full',
        settings: { paypal: { clientId: 'id', clientSecret: 'secret' } },
      }),
    ),
  };
  const paypal = {
    captureOrder: jest.fn(() => Promise.resolve({ status: 'COMPLETED' })),
    createOrder: jest.fn(() =>
      Promise.resolve({ id: 'PAYPAL-ORDER-2', links: [] }),
    ),
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
  const tseSigning = {
    isActive: jest.fn(() => Promise.resolve(options.tse !== false)),
    signPayment: jest.fn(() => {
      calls.push('tse.signPayment');
      return Promise.resolve(SIGNED);
    }),
  };
  const none = undefined as never;
  const svc = new OnlineOrdersService(
    sessionRepository,
    none,
    none,
    none,
    orderRepository as never,
    none,
    organizationRepository as never,
    paymentRepository as never,
    paypal as never,
    none,
    { get: jest.fn(() => '') } as never,
    print as never,
    none,
    undefined,
    tseSigning as never,
  );
  return { svc, calls, print, tseSigning, paypal, paymentRepository };
}

describe('QR order payment (PayPal) with Cloud-TSE', () => {
  it('signs the captured payment after saving and before kitchen ticket and receipt', async () => {
    const { svc, calls, print, tseSigning } = setup();

    const result = await svc.confirmPayment(
      'sess_1',
      'pay-1',
      'PAYPAL-ORDER-1',
    );

    expect(result.data.status).toBe(PaymentTransactionStatus.CAPTURED);
    expect(tseSigning.signPayment).toHaveBeenCalledWith('pay-1');
    expect(calls).toEqual([
      'payment.capture',
      'order.save',
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

  it('a second confirmation (return page reloaded) does not sign again', async () => {
    const { svc, tseSigning, print, paymentRepository } = setup();

    await svc.confirmPayment('sess_1', 'pay-1', 'PAYPAL-ORDER-1');
    // Zweiter Aufruf mit dem alten Stand (gleichzeitig gelesen): der
    // Wechsel auf CAPTURED ist schon vergeben.
    paymentRepository.findOne.mockImplementation(() =>
      Promise.resolve({
        id: 'pay-1',
        status: PaymentTransactionStatus.PENDING,
        paymentProvider: PaymentProvider.PAYPAL,
        amount: 12,
        order: { id: 'order-1', onlineSessionId: 'session-1' },
      } as never),
    );
    const second = await svc.confirmPayment(
      'sess_1',
      'pay-1',
      'PAYPAL-ORDER-1',
    );

    expect(second.data.status).toBe('already_captured');
    expect(tseSigning.signPayment).toHaveBeenCalledTimes(1);
    expect(print.handlePaymentReceived).toHaveBeenCalledTimes(1);
  });

  it('organisation without active TSE: no signing, receipt without TSE block', async () => {
    const { svc, tseSigning, print } = setup({ tse: false });

    await svc.confirmPayment('sess_1', 'pay-1', 'PAYPAL-ORDER-1');

    expect(tseSigning.signPayment).not.toHaveBeenCalled();
    expect(print.handlePaymentReceived).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({ tse: null }),
    );
  });

  it('cashless: a payment method outside the positive list is rejected before anything is created', async () => {
    const { svc, paypal } = setup({ operatingMode: 'cashless' });

    const call = svc.initiatePayment('sess_1', {
      paymentMethod: 'voucher' as OnlinePaymentMethod,
    });
    await expect(call).rejects.toBeInstanceOf(ForbiddenException);
    await expect(call).rejects.toMatchObject({
      response: { reason: 'PAYMENT_METHOD_NOT_ALLOWED_CASHLESS' },
    });
    expect(paypal.createOrder).not.toHaveBeenCalled();
  });

  it('cashless: PayPal (on the list) still starts', async () => {
    const { svc, paypal } = setup({ operatingMode: 'cashless' });

    await svc.initiatePayment('sess_1', {
      paymentMethod: OnlinePaymentMethod.PAYPAL,
    });
    expect(paypal.createOrder).toHaveBeenCalledTimes(1);
  });
});
