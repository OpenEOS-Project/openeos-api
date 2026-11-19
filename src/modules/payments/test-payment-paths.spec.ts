import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';

import { Device } from '../../database/entities/device.entity';
import { Event, EventStatus } from '../../database/entities/event.entity';
import { Order } from '../../database/entities/order.entity';
import { OrderItem } from '../../database/entities/order-item.entity';
import { Organization } from '../../database/entities/organization.entity';
import {
  Payment,
  PaymentMethod,
  PaymentProvider,
} from '../../database/entities/payment.entity';
import { Refund } from '../../database/entities/refund.entity';
import { DeviceApiController } from '../devices/device-api.controller';
import { GatewayService } from '../gateway/gateway.service';
import { OrderPrintService } from '../print-jobs/order-print.service';
import { paymentMethodLabel } from '../print-jobs/receipt-labels';
import { TseSigningService } from '../tse/tse-signing.service';
import { transactionManager } from './testing/transaction-manager';

/**
 * Testzahlungen an der Kasse (test-payment.util.ts): „Bar (Test)“ und
 * „Karte (Test)“ gehen nur fuer Testbestellungen — in jeder Betriebsart
 * ausser „Nur Bons“, auch in Deutschland ohne TSE und ohne SumUp. Sie
 * oeffnen keine Kassenlade und werden nicht signiert. Sammelzahlung:
 * payments-batch.spec.ts; Kassenbuch und Loeschen: test-payments.db.spec.ts.
 */

const ORG_ID = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a11';

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

function organization(
  mode: 'full' | 'cashless' | 'orders_only',
  country = 'DE',
): Organization {
  return {
    id: ORG_ID,
    country,
    operatingMode: mode,
    operatingModeLegacy: false,
    tseActive: false,
    // Kein SumUp: Testzahlungen brauchen keine Integration.
    settings: { currency: 'EUR' },
  } as unknown as Organization;
}

function openOrder(isTest: boolean): Order {
  return {
    id: 'order-1',
    organizationId: ORG_ID,
    eventId: 'event-1',
    orderNumber: 'A-1',
    total: 10,
    paidAmount: 0,
    paymentStatus: 'unpaid',
    isTest,
    items: [
      {
        id: 'item-1',
        productName: 'Bier',
        quantity: 2,
        paidQuantity: 0,
        unitPrice: 5,
        optionsPrice: 0,
        status: 'pending',
        productionStationId: null,
      },
    ] as unknown as OrderItem[],
  } as unknown as Order;
}

const device = {
  id: 'device-1',
  organizationId: ORG_ID,
  settings: { cashDrawerPrinterId: 'printer-1' },
} as unknown as Device;

function setup(org: Organization, isTest: boolean) {
  const organizationRepository = {
    findOne: jest.fn(() => Promise.resolve(org)),
  };
  const event = {
    id: 'event-1',
    status: isTest ? EventStatus.TEST : EventStatus.ACTIVE,
  };
  const eventRepository = {
    find: jest.fn(() => Promise.resolve([event])),
    findOne: jest.fn(() => Promise.resolve(event)),
  };
  const orderRepository = {
    findOne: jest.fn(() => Promise.resolve(openOrder(isTest))),
    save: jest.fn((o: Order) => Promise.resolve(o)),
  };
  const orderItemRepository = {
    save: jest.fn((i: OrderItem) => Promise.resolve(i)),
  };
  const paymentRepository = {
    create: jest.fn((p: Partial<Payment>) => ({ id: 'payment-1', ...p })),
    save: jest.fn((p: Payment) => Promise.resolve(p)),
  };
  const gatewayService = { sendOpenCashDrawer: jest.fn() };
  const orderPrintService = {
    handlePaymentReceived: jest.fn(() => Promise.resolve()),
  } as unknown as OrderPrintService;
  Object.assign(orderRepository, {
    manager: transactionManager([
      [Order, orderRepository],
      [OrderItem, orderItemRepository],
      [Payment, paymentRepository],
    ]),
  });
  const none = undefined as never;
  const controller = new DeviceApiController(
    organizationRepository as unknown as Repository<Organization>,
    eventRepository as unknown as Repository<Event>,
    none,
    none,
    orderRepository as unknown as Repository<Order>,
    orderItemRepository as unknown as Repository<OrderItem>,
    paymentRepository as unknown as Repository<Payment>,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    gatewayService as unknown as GatewayService,
    orderPrintService,
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
  return { controller, paymentRepository, gatewayService };
}

describe('Testzahlungen an der Kasse (DeviceApiController)', () => {
  it.each([
    ['DE full without TSE', organization('full')],
    ['DE cashless', organization('cashless')],
    ['AT full', organization('full', 'AT')],
  ])(
    '%s: test_cash and test_card go through for a test order',
    async (_label, org) => {
      for (const method of [PaymentMethod.TEST_CASH, PaymentMethod.TEST_CARD]) {
        const { controller, paymentRepository } = setup(org, true);
        await controller.createPayment(device, {
          orderId: 'order-1',
          amount: 10,
          paymentMethod: method,
          amountReceived: 20,
        });
        expect(paymentRepository.save).toHaveBeenCalledTimes(1);
        expect(paymentRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            paymentMethod: method,
            paymentProvider: PaymentProvider.TEST,
            // Kein Bargeld: kein erhaltener Betrag fuer den Bon.
            metadata: {},
          }),
        );
      }
    },
  );

  it('a split test cash payment never opens the cash drawer', async () => {
    const { controller, paymentRepository, gatewayService } = setup(
      organization('full', 'AT'),
      true,
    );
    await controller.createSplitPayment(device, {
      orderId: 'order-1',
      amount: 5,
      paymentMethod: PaymentMethod.TEST_CASH,
      items: [{ orderItemId: 'item-1', quantity: 1 }],
      amountReceived: 10,
    });
    expect(paymentRepository.save).toHaveBeenCalledTimes(1);
    expect(gatewayService.sendOpenCashDrawer).not.toHaveBeenCalled();
  });

  it.each([[PaymentMethod.TEST_CASH], [PaymentMethod.TEST_CARD]])(
    '%s on a real order: 403 TEST_PAYMENT_REQUIRES_TEST_ORDER (single and split)',
    async (method) => {
      const { controller, paymentRepository } = setup(
        organization('full', 'AT'),
        false,
      );
      const expected = {
        status: 403,
        response: { reason: 'TEST_PAYMENT_REQUIRES_TEST_ORDER' },
      };
      await expect(
        controller.createPayment(device, {
          orderId: 'order-1',
          amount: 10,
          paymentMethod: method,
        }),
      ).rejects.toMatchObject(expected);
      await expect(
        controller.createSplitPayment(device, {
          orderId: 'order-1',
          amount: 5,
          paymentMethod: method,
          items: [{ orderItemId: 'item-1', quantity: 1 }],
        }),
      ).rejects.toMatchObject(expected);
      expect(paymentRepository.save).not.toHaveBeenCalled();
    },
  );

  it('„Nur Bons“: no test payment (403 ORDER_ONLY_MODE)', async () => {
    const { controller, paymentRepository } = setup(
      organization('orders_only'),
      true,
    );
    await expect(
      controller.createPayment(device, {
        orderId: 'order-1',
        amount: 10,
        paymentMethod: PaymentMethod.TEST_CASH,
      }),
    ).rejects.toMatchObject({ response: { code: 'ORDER_ONLY_MODE' } });
    expect(paymentRepository.save).not.toHaveBeenCalled();
  });

  it('DE full without TSE: real cash on a test order stays blocked', async () => {
    const { controller, paymentRepository } = setup(organization('full'), true);
    await expect(
      controller.createPayment(device, {
        orderId: 'order-1',
        amount: 10,
        paymentMethod: PaymentMethod.CASH,
        amountReceived: 10,
      }),
    ).rejects.toMatchObject({ response: { code: 'TSE_REQUIRED_FOR_CASH' } });
    expect(paymentRepository.save).not.toHaveBeenCalled();
  });
});

describe('Testzahlungen: keine TSE, klarer Bon', () => {
  function signing(payment: Partial<Payment>) {
    const units = { get: jest.fn(() => Promise.resolve({ id: 'unit-1' })) };
    const service = new TseSigningService(
      {} as never,
      {} as never,
      { findOne: jest.fn(() => Promise.resolve(payment)) } as never,
      { findOne: jest.fn(() => Promise.resolve(openOrder(true))) } as never,
      {} as never,
      units as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, units };
  }

  it.each([[PaymentMethod.TEST_CASH], [PaymentMethod.TEST_CARD]])(
    '%s is never signed, its refund neither',
    async (method) => {
      const { service, units } = signing({
        id: 'payment-1',
        orderId: 'order-1',
        paymentMethod: method,
      });
      await expect(service.signPayment('payment-1')).resolves.toBeNull();
      await expect(
        service.signRefund({
          organizationId: ORG_ID,
          paymentMethod: method,
          isTest: true,
          status: 'test',
        } as unknown as Refund),
      ).resolves.toBeNull();
      // Nicht einmal nach der TSE der Organisation gefragt.
      expect(units.get).not.toHaveBeenCalled();
    },
  );

  it('receipt labels say there was no money', () => {
    expect(paymentMethodLabel('test_cash')).toBe('Bar (Test – kein Geld)');
    expect(paymentMethodLabel('test_card')).toBe('Karte (Test – kein Geld)');
  });
});
