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
import { PfandReturnsService } from '../pfand-types/pfand-returns.service';
import { OrderPrintService } from '../print-jobs/order-print.service';
import { allocateRefundFor } from '../refunds/refund-calc';
import { PaymentsService } from './payments.service';

/**
 * Bargeldloser Modus (`settings.payments.cashless`): jeder Einstieg, der
 * Bargeld bucht oder auszahlt, antwortet mit 403 CASH_PAYMENTS_DISABLED;
 * Karte, SumUp und Online laufen weiter — auch geteilt und mit Trinkgeld.
 * Sammelzahlung und Bestellung mit Zahlung: payments-batch.spec.ts und
 * device-orders.spec.ts.
 */

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

const ORG_ID = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a11';

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

function organization(cashless: boolean): Organization {
  return {
    id: ORG_ID,
    settings: {
      currency: 'EUR',
      integrations: { sumup: { enabled: true } },
      ...(cashless ? { payments: { cashless: true } } : {}),
    },
  } as unknown as Organization;
}

async function expectCashDisabled(call: Promise<unknown>): Promise<void> {
  await expect(call).rejects.toBeInstanceOf(ForbiddenException);
  await expect(call).rejects.toMatchObject({
    response: { code: 'CASH_PAYMENTS_DISABLED' },
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

describe('Bargeldloser Modus — Kasse (DeviceApiController)', () => {
  const device = {
    id: 'device-1',
    organizationId: ORG_ID,
    settings: { cashDrawerPrinterId: 'printer-1' },
  } as unknown as Device;

  function setup(cashless: boolean) {
    const organizationRepository = {
      findOne: jest.fn(() => Promise.resolve(organization(cashless))),
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

    // Pfand-Rueckgabe mit dem echten Dienst: die Sperre steckt dort.
    const pfandReturnRepository = {
      manager: {
        findOne: jest.fn((entity: unknown) =>
          Promise.resolve(
            entity === Organization ? organization(cashless) : null,
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
      none,
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
      none,
      none,
      none,
    );
    return {
      controller,
      paymentRepository,
      gatewayService,
      pfandReturnRepository,
    };
  }

  it('POST /device-api/payments: rejects cash, books nothing', async () => {
    const { controller, paymentRepository } = setup(true);

    await expectCashDisabled(
      controller.createPayment(device, {
        orderId: 'order-1',
        amount: 10,
        paymentMethod: PaymentMethod.CASH,
        amountReceived: 20,
      }),
    );
    expect(paymentRepository.save).not.toHaveBeenCalled();
  });

  it.each([[PaymentMethod.CARD], [PaymentMethod.SUMUP_TERMINAL]])(
    'POST /device-api/payments: books %s',
    async (paymentMethod) => {
      const { controller, paymentRepository } = setup(true);

      await controller.createPayment(device, {
        orderId: 'order-1',
        amount: 10,
        paymentMethod,
      });
      expect(paymentRepository.save).toHaveBeenCalledTimes(1);
    },
  );

  it('POST /device-api/payments/split: rejects the cash part', async () => {
    const { controller, paymentRepository, gatewayService } = setup(true);

    await expectCashDisabled(
      controller.createSplitPayment(device, {
        orderId: 'order-1',
        amount: 5,
        paymentMethod: PaymentMethod.CASH,
        items: [{ orderItemId: 'item-1', quantity: 1 }],
        amountReceived: 10,
      }),
    );
    expect(paymentRepository.save).not.toHaveBeenCalled();
    expect(gatewayService.sendOpenCashDrawer).not.toHaveBeenCalled();
  });

  it.each([[PaymentMethod.CARD], [PaymentMethod.SUMUP_TERMINAL]])(
    'POST /device-api/payments/split: books a %s part',
    async (paymentMethod) => {
      const { controller, paymentRepository } = setup(true);

      await controller.createSplitPayment(device, {
        orderId: 'order-1',
        amount: 5,
        paymentMethod,
        items: [{ orderItemId: 'item-1', quantity: 1 }],
      });
      expect(paymentRepository.save).toHaveBeenCalledTimes(1);
    },
  );

  it('POST /device-api/pfand-returns: no cash payout of the deposit', async () => {
    const { controller, pfandReturnRepository, gatewayService } = setup(true);

    await expectCashDisabled(
      controller.createPfandReturn(device, {
        lines: [{ pfandTypeId: 'pt-1', quantity: 2 }],
      }),
    );
    expect(pfandReturnRepository.save).not.toHaveBeenCalled();
    expect(gatewayService.sendOpenCashDrawer).not.toHaveBeenCalled();
  });

  it('POST /device-api/cash-drawer/open: no cash drawer', async () => {
    const { controller, gatewayService } = setup(true);

    await expectCashDisabled(controller.openCashDrawer(device));
    expect(gatewayService.sendOpenCashDrawer).not.toHaveBeenCalled();
  });

  it('cash mode (default): cash payment, Pfand payout and drawer work as before', async () => {
    const {
      controller,
      paymentRepository,
      pfandReturnRepository,
      gatewayService,
    } = setup(false);

    await controller.createPayment(device, {
      orderId: 'order-1',
      amount: 10,
      paymentMethod: PaymentMethod.CASH,
      amountReceived: 20,
    });
    await controller.createPfandReturn(device, {
      lines: [{ pfandTypeId: 'pt-1', quantity: 2 }],
    });
    await controller.openCashDrawer(device);

    expect(paymentRepository.save).toHaveBeenCalledTimes(1);
    expect(pfandReturnRepository.save).toHaveBeenCalledTimes(1);
    expect(gatewayService.sendOpenCashDrawer).toHaveBeenCalledTimes(2);
  });
});

describe('Bargeldloser Modus — Verwaltung (PaymentsService)', () => {
  const user = { id: 'user-1' } as User;

  function setup(cashless: boolean) {
    const paymentRepository = {
      create: jest.fn((p: Partial<Payment>) => ({ id: 'payment-1', ...p })),
      save: jest.fn((p: Payment) => Promise.resolve(p)),
      findOne: jest.fn(() =>
        Promise.resolve({ id: 'payment-1', order: { organizationId: ORG_ID } }),
      ),
    };
    const orderRepository = {
      findOne: jest.fn(() => Promise.resolve(openOrder())),
      save: jest.fn((o: Order) => Promise.resolve(o)),
    };
    const orderItemRepository = {
      save: jest.fn((i: OrderItem) => Promise.resolve(i)),
    };
    const orderItemPaymentRepository = {
      create: jest.fn((x: object) => x),
      save: jest.fn((x: object) => Promise.resolve(x)),
    };
    const userOrganizationRepository = {
      findOne: jest.fn(() => Promise.resolve({ role: 'admin' })),
    };
    const organizationRepository = {
      findOne: jest.fn(() => Promise.resolve(organization(cashless))),
    };
    const orderPrintService = {
      handlePaymentReceived: jest.fn(() => Promise.resolve()),
    };
    const service = new PaymentsService(
      paymentRepository as never,
      orderRepository as never,
      orderItemRepository as never,
      orderItemPaymentRepository as never,
      userOrganizationRepository as never,
      organizationRepository as never,
      orderPrintService as never,
    );
    return { service, paymentRepository };
  }

  it('POST /organizations/:id/payments: rejects cash', async () => {
    const { service, paymentRepository } = setup(true);

    await expectCashDisabled(
      service.create(
        ORG_ID,
        { orderId: 'order-1', amount: 10, paymentMethod: PaymentMethod.CASH },
        user,
      ),
    );
    expect(paymentRepository.save).not.toHaveBeenCalled();
  });

  it('POST /organizations/:id/payments/split: rejects the cash part', async () => {
    const { service, paymentRepository } = setup(true);

    await expectCashDisabled(
      service.createSplitPayment(
        ORG_ID,
        {
          orderId: 'order-1',
          amount: 5,
          paymentMethod: PaymentMethod.CASH,
          items: [{ orderItemId: 'item-1', quantity: 1 }],
        },
        user,
      ),
    );
    expect(paymentRepository.save).not.toHaveBeenCalled();
  });

  it('books card payments and card split parts', async () => {
    const { service, paymentRepository } = setup(true);

    await service.create(
      ORG_ID,
      { orderId: 'order-1', amount: 10, paymentMethod: PaymentMethod.CARD },
      user,
    );
    await service.createSplitPayment(
      ORG_ID,
      {
        orderId: 'order-1',
        amount: 5,
        paymentMethod: PaymentMethod.CARD,
        items: [{ orderItemId: 'item-1', quantity: 1 }],
      },
      user,
    );
    expect(paymentRepository.save).toHaveBeenCalledTimes(2);
  });

  it('cash mode (default): cash still works', async () => {
    const { service, paymentRepository } = setup(false);

    await service.create(
      ORG_ID,
      { orderId: 'order-1', amount: 10, paymentMethod: PaymentMethod.CASH },
      user,
    );
    expect(paymentRepository.save).toHaveBeenCalledTimes(1);
  });
});

describe('Bargeldloser Modus — Erstattung (allocateRefundFor)', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 14, 18, minutes));
  const cash = {
    id: 'cash',
    refundable: 1000,
    isProvider: false,
    isCash: true,
    createdAt: at(0),
  };
  const card = {
    id: 'card',
    refundable: 600,
    isProvider: true,
    isCash: false,
    createdAt: at(5),
  };

  it('refunds go back via the non-cash payment', () => {
    // Ohne Modus: juengste zuerst, Rest bar.
    expect(allocateRefundFor([cash, card], 1200, null, false)).toEqual({
      allocation: [
        { paymentId: 'card', amount: 600 },
        { paymentId: 'cash', amount: 600 },
      ],
      cashBlocked: false,
    });
    // Bargeldlos: nur auf die Karte.
    expect(allocateRefundFor([cash, card], 500, null, true)).toEqual({
      allocation: [{ paymentId: 'card', amount: 500 }],
      cashBlocked: false,
    });
    // Auch wenn die Barzahlung juenger ist.
    expect(
      allocateRefundFor([{ ...cash, createdAt: at(10) }, card], 500, null, true)
        .allocation,
    ).toEqual([{ paymentId: 'card', amount: 500 }]);
  });

  it('blocks a refund that would need cash', () => {
    expect(allocateRefundFor([cash, card], 1200, null, true)).toEqual({
      allocation: null,
      cashBlocked: true,
    });
    expect(allocateRefundFor([cash], 100, null, true).cashBlocked).toBe(true);
    // Ausdruecklich die Barzahlung gewaehlt.
    expect(allocateRefundFor([cash, card], 100, 'cash', true)).toEqual({
      allocation: null,
      cashBlocked: true,
    });
  });

  it('a plain shortfall without cash stays a normal error', () => {
    expect(allocateRefundFor([card], 700, null, true)).toEqual({
      allocation: null,
      cashBlocked: false,
    });
  });
});
