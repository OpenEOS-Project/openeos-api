import { ForbiddenException, Logger } from '@nestjs/common';
import { Repository } from 'typeorm';

import { Device } from '../../database/entities/device.entity';
import { Event, EventStatus } from '../../database/entities/event.entity';
import { Order } from '../../database/entities/order.entity';
import { OrderItem } from '../../database/entities/order-item.entity';
import { Organization } from '../../database/entities/organization.entity';
import { Payment, PaymentMethod } from '../../database/entities/payment.entity';
import { PfandReturn } from '../../database/entities/pfand-return.entity';
import { PfandType } from '../../database/entities/pfand-type.entity';
import { User } from '../../database/entities/user.entity';
import { DeviceApiController } from '../devices/device-api.controller';
import { GatewayService } from '../gateway/gateway.service';
import { OrdersService } from '../orders/orders.service';
import { PfandReturnsService } from '../pfand-types/pfand-returns.service';
import { OrderPrintService } from '../print-jobs/order-print.service';
import { SumUpService } from '../sumup/sumup.service';
import { BatchPaymentDto } from './dto/batch-payment.dto';
import { PaymentsBatchService } from './payments-batch.service';
import { PaymentsService } from './payments.service';

/**
 * Betriebsmodus „Nur Bestellen“ (`settings.operatingMode = 'order_only'`):
 * jeder Einstieg, der eine Zahlung bucht oder abrechnet, antwortet mit 403
 * ORDER_ONLY_MODE — unabhaengig von der Zahlart (bar, Karte, SumUp).
 * Bestellung mit Zahlung/Trinkgeld: device-orders.spec.ts; Abschluss ohne
 * Zahlung: orders-deliver.spec.ts; Erstattung: refunds.db.spec.ts.
 */

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

const ORG_ID = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a99';

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

function organization(orderOnly: boolean): Organization {
  return {
    id: ORG_ID,
    settings: {
      currency: 'EUR',
      integrations: { sumup: { enabled: true } },
      sumup: { apiKey: 'sup_sk_test', merchantCode: 'M1' },
      ...(orderOnly ? { operatingMode: 'order_only' } : {}),
    },
  } as unknown as Organization;
}

async function expectOrderOnly(call: Promise<unknown>): Promise<void> {
  await expect(call).rejects.toBeInstanceOf(ForbiddenException);
  await expect(call).rejects.toMatchObject({
    response: { code: 'ORDER_ONLY_MODE' },
  });
}

function openOrder(): Order {
  return {
    id: 'order-1',
    organizationId: ORG_ID,
    eventId: 'event-1',
    orderNumber: 'A-1',
    total: 10,
    paidAmount: 0,
    paymentStatus: 'unpaid',
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

const METHODS = [
  [PaymentMethod.CASH],
  [PaymentMethod.CARD],
  [PaymentMethod.SUMUP_TERMINAL],
] as const;

describe('„Nur Bestellen“ — Kasse (DeviceApiController)', () => {
  const device = {
    id: 'device-1',
    organizationId: ORG_ID,
    settings: { cashDrawerPrinterId: 'printer-1', sumupReaderId: 'reader-1' },
  } as unknown as Device;

  function setup(orderOnly: boolean) {
    const organizationRepository = {
      findOne: jest.fn(() => Promise.resolve(organization(orderOnly))),
    };
    const event = { id: 'event-1', status: EventStatus.ACTIVE };
    const eventRepository = {
      find: jest.fn(() => Promise.resolve([event])),
      findOne: jest.fn(() => Promise.resolve(event)),
    };
    const orderRepository = {
      findOne: jest.fn(() => Promise.resolve(openOrder())),
      save: jest.fn((o: Order) => Promise.resolve(o)),
    };
    const orderItemRepository = {
      save: jest.fn((i: OrderItem) => Promise.resolve(i)),
    };
    const paymentRepository = {
      create: jest.fn((p: Partial<Payment>) => ({ id: 'payment-1', ...p })),
      save: jest.fn((p: Payment) => Promise.resolve(p)),
    };
    const printerRepository = {
      findOne: jest.fn(() =>
        Promise.resolve({
          id: 'printer-1',
          hasCashDrawer: true,
          isActive: true,
        }),
      ),
    };
    const gatewayService = {
      sendOpenCashDrawer: jest.fn(),
      notifyPfandReturned: jest.fn(),
    };
    const orderPrintService = {
      handlePaymentReceived: jest.fn(() => Promise.resolve()),
    } as unknown as OrderPrintService;
    const sumupApiService = {
      initiateCheckout: jest.fn(() => Promise.resolve({ data: {} })),
    };
    const refundsService = {
      resolveDeviceActor: jest.fn(),
      createRefund: jest.fn(),
    };

    const pfandReturnRepository = {
      manager: {
        findOne: jest.fn((entity: unknown) =>
          Promise.resolve(
            entity === Organization ? organization(orderOnly) : null,
          ),
        ),
      },
      create: jest.fn((data: Partial<PfandReturn>) => ({
        id: 'pr-1',
        ...data,
      })),
      save: jest.fn((row: PfandReturn) => Promise.resolve(row)),
    };
    const pfandTypeRepository = {
      find: jest.fn(() =>
        Promise.resolve([{ id: 'pt-1', name: 'Becher', amount: 2 }]),
      ),
    };
    const pfandReturnsService = new PfandReturnsService(
      pfandReturnRepository as unknown as Repository<PfandReturn>,
      pfandTypeRepository as unknown as Repository<PfandType>,
      gatewayService as unknown as GatewayService,
    );

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
      printerRepository as never,
      none,
      none,
      sumupApiService as never,
      none,
      none,
      gatewayService as unknown as GatewayService,
      orderPrintService,
      none,
      none,
      none,
      none,
      pfandReturnsService,
      none,
      none,
      refundsService as never,
      none,
      none,
    );
    return {
      controller,
      paymentRepository,
      gatewayService,
      pfandReturnRepository,
      sumupApiService,
      refundsService,
    };
  }

  it.each(METHODS)(
    'POST /device-api/payments: rejects %s, books nothing',
    async (paymentMethod) => {
      const { controller, paymentRepository } = setup(true);
      await expectOrderOnly(
        controller.createPayment(device, {
          orderId: 'order-1',
          amount: 10,
          paymentMethod,
        }),
      );
      expect(paymentRepository.save).not.toHaveBeenCalled();
    },
  );

  it.each(METHODS)(
    'POST /device-api/payments/split: rejects a %s part',
    async (paymentMethod) => {
      const { controller, paymentRepository } = setup(true);
      await expectOrderOnly(
        controller.createSplitPayment(device, {
          orderId: 'order-1',
          amount: 5,
          paymentMethod,
          items: [{ orderItemId: 'item-1', quantity: 1 }],
        }),
      );
      expect(paymentRepository.save).not.toHaveBeenCalled();
    },
  );

  it('POST /device-api/pfand-returns: no payout', async () => {
    const { controller, pfandReturnRepository, gatewayService } = setup(true);
    await expectOrderOnly(
      controller.createPfandReturn(device, {
        lines: [{ pfandTypeId: 'pt-1', quantity: 2 }],
      }),
    );
    expect(pfandReturnRepository.save).not.toHaveBeenCalled();
    expect(gatewayService.sendOpenCashDrawer).not.toHaveBeenCalled();
  });

  it('POST /device-api/cash-drawer/open: no cash drawer', async () => {
    const { controller, gatewayService } = setup(true);
    await expectOrderOnly(controller.openCashDrawer(device));
    expect(gatewayService.sendOpenCashDrawer).not.toHaveBeenCalled();
  });

  it('POST /device-api/sumup/checkout: no card checkout', async () => {
    const { controller, sumupApiService } = setup(true);
    await expectOrderOnly(
      controller.initiateSumupCheckout(device, { amount: 10 }),
    );
    expect(sumupApiService.initiateCheckout).not.toHaveBeenCalled();
  });

  it('POST /device-api/orders/:id/refunds: the till never refunds', async () => {
    const { controller, refundsService } = setup(true);
    await expectOrderOnly(
      controller.createRefund(device, 'order-1', {
        mode: 'full',
        reasonCode: 'other',
      } as never),
    );
    expect(refundsService.createRefund).not.toHaveBeenCalled();
  });

  it('cash register mode (default): payments and the drawer work as before', async () => {
    const { controller, paymentRepository, gatewayService } = setup(false);
    await controller.createPayment(device, {
      orderId: 'order-1',
      amount: 10,
      paymentMethod: PaymentMethod.CARD,
    });
    await controller.openCashDrawer(device);
    expect(paymentRepository.save).toHaveBeenCalledTimes(1);
    expect(gatewayService.sendOpenCashDrawer).toHaveBeenCalledTimes(1);
  });
});

describe('„Nur Bestellen“ — Sammelzahlung (PaymentsBatchService)', () => {
  it.each(METHODS)(
    'POST /device-api/payments/batch: rejects %s before locking orders',
    async (paymentMethod) => {
      const manager = {
        findOne: jest.fn(() => Promise.resolve(organization(true))),
        find: jest.fn(() => Promise.resolve([])),
      };
      const service = new PaymentsBatchService(
        {
          transaction: (work: (m: unknown) => Promise<unknown>) =>
            work(manager),
        } as never,
        {} as never,
        {} as never,
      );
      await expectOrderOnly(
        service.payBatch(ORG_ID, 'device-1', {
          paymentMethod,
          orderIds: ['order-1'],
        } as BatchPaymentDto),
      );
      expect(manager.find).not.toHaveBeenCalled();
    },
  );
});

describe('„Nur Bestellen“ — Verwaltung', () => {
  const user = { id: 'user-1' } as User;

  function paymentsService() {
    const paymentRepository = {
      create: jest.fn((p: Partial<Payment>) => ({ id: 'payment-1', ...p })),
      save: jest.fn((p: Payment) => Promise.resolve(p)),
    };
    const service = new PaymentsService(
      paymentRepository as never,
      { findOne: jest.fn(() => Promise.resolve(openOrder())) } as never,
      { save: jest.fn() } as never,
      { create: jest.fn(), save: jest.fn() } as never,
      { findOne: jest.fn(() => Promise.resolve({ role: 'admin' })) } as never,
      { findOne: jest.fn(() => Promise.resolve(organization(true))) } as never,
      { handlePaymentReceived: jest.fn() } as never,
    );
    return { service, paymentRepository };
  }

  it.each(METHODS)(
    'POST /organizations/:id/payments: rejects %s',
    async (paymentMethod) => {
      const { service, paymentRepository } = paymentsService();
      await expectOrderOnly(
        service.create(
          ORG_ID,
          { orderId: 'order-1', amount: 10, paymentMethod },
          user,
        ),
      );
      expect(paymentRepository.save).not.toHaveBeenCalled();
    },
  );

  it('POST /organizations/:id/payments/split: rejects a card part', async () => {
    const { service, paymentRepository } = paymentsService();
    await expectOrderOnly(
      service.createSplitPayment(
        ORG_ID,
        {
          orderId: 'order-1',
          amount: 5,
          paymentMethod: PaymentMethod.CARD,
          items: [{ orderItemId: 'item-1', quantity: 1 }],
        },
        user,
      ),
    );
    expect(paymentRepository.save).not.toHaveBeenCalled();
  });

  it('POST /organizations/:id/sumup/readers/:id/checkout: rejected', async () => {
    const sumUpApiService = { initiateCheckout: jest.fn() };
    const service = new SumUpService(
      { findOne: jest.fn(() => Promise.resolve(organization(true))) } as never,
      { findOne: jest.fn(() => Promise.resolve({ role: 'admin' })) } as never,
      sumUpApiService as never,
      {} as never,
      { find: jest.fn(() => Promise.resolve([])) } as never,
    );
    await expectOrderOnly(
      service.initiateCheckout(ORG_ID, 'reader-1', 10, 'EUR', user),
    );
    expect(sumUpApiService.initiateCheckout).not.toHaveBeenCalled();
  });

  it('PATCH /organizations/:id/orders/:id: no tip', async () => {
    const orderRepository = {
      findOne: jest.fn(() =>
        Promise.resolve({ ...openOrder(), status: 'open' }),
      ),
      save: jest.fn(),
    };
    const none = undefined as never;
    const service = new OrdersService(
      orderRepository as never,
      none,
      none,
      { findOne: jest.fn(() => Promise.resolve(organization(true))) } as never,
      { findOne: jest.fn(() => Promise.resolve({ role: 'admin' })) } as never,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
    );
    await expectOrderOnly(
      service.update(ORG_ID, 'order-1', { tipAmount: 2 }, user),
    );
    expect(orderRepository.save).not.toHaveBeenCalled();
  });
});
