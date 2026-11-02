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
import { BatchPaymentDto } from './dto/batch-payment.dto';
import { PaymentsBatchService } from './payments-batch.service';
import { PaymentsService } from './payments.service';
import { tseStatus } from '../../common/utils/tse.util';

/**
 * Betriebsart „Alle Funktionen“ (`full`) in Deutschland: Bargeld nur mit
 * aktiver Cloud-TSE (tse.util.ts). Ohne TSE antwortet jeder Einstieg, der
 * Bargeld bucht oder auszahlt, mit 403 TSE_REQUIRED_FOR_CASH; Karte geht
 * weiter. Bestand (`operatingModeLegacy`), aktive TSE und andere Laender
 * wie bisher. Wechsel und Bescheinigung: operating-mode.db.spec.ts.
 */

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

const ORG_ID = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a99';

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

type Kind = 'de_new' | 'de_legacy' | 'de_tse' | 'at';

afterEach(() => {
  tseStatus.isActive = () => false;
});

function organization(kind: Kind): Organization {
  // Aktive TSE ueber die eine Stelle, die die TSE-Anbindung ersetzt.
  if (kind === 'de_tse') tseStatus.isActive = () => true;
  return {
    id: ORG_ID,
    country: kind === 'at' ? 'AT' : 'DE',
    operatingMode: 'full',
    operatingModeLegacy: kind === 'de_legacy',
    settings: {
      currency: 'EUR',
      integrations: { sumup: { enabled: true } },
      sumup: { apiKey: 'sup_sk_test', merchantCode: 'M1' },
    },
  } as unknown as Organization;
}

async function expectBlocked(call: Promise<unknown>): Promise<void> {
  await expect(call).rejects.toBeInstanceOf(ForbiddenException);
  await expect(call).rejects.toMatchObject({
    response: { code: 'TSE_REQUIRED_FOR_CASH' },
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

describe('Alle Funktionen in Deutschland ohne TSE — Kasse (DeviceApiController)', () => {
  const device = {
    id: 'device-1',
    organizationId: ORG_ID,
    settings: { cashDrawerPrinterId: 'printer-1', sumupReaderId: 'reader-1' },
  } as unknown as Device;

  function setup(kind: Kind, order: Order = openOrder()) {
    const organizationRepository = {
      findOne: jest.fn(() => Promise.resolve(organization(kind))),
    };
    const event = { id: 'event-1', status: EventStatus.ACTIVE };
    const eventRepository = {
      find: jest.fn(() => Promise.resolve([event])),
      findOne: jest.fn(() => Promise.resolve(event)),
    };
    const orderRepository = {
      findOne: jest.fn(() => Promise.resolve(order)),
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
          Promise.resolve(entity === Organization ? organization(kind) : null),
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

  it('POST /device-api/payments: rejects cash, books nothing', async () => {
    const { controller, paymentRepository } = setup('de_new');
    await expectBlocked(
      controller.createPayment(device, {
        orderId: 'order-1',
        amount: 10,
        paymentMethod: PaymentMethod.CASH,
      }),
    );
    expect(paymentRepository.save).not.toHaveBeenCalled();
  });

  it('POST /device-api/payments/split: rejects a cash part', async () => {
    const { controller, paymentRepository } = setup('de_new');
    await expectBlocked(
      controller.createSplitPayment(device, {
        orderId: 'order-1',
        amount: 5,
        paymentMethod: PaymentMethod.CASH,
        items: [{ orderItemId: 'item-1', quantity: 1 }],
      }),
    );
    expect(paymentRepository.save).not.toHaveBeenCalled();
  });

  it('POST /device-api/payments: card still works', async () => {
    const { controller, paymentRepository } = setup('de_new');
    await controller.createPayment(device, {
      orderId: 'order-1',
      amount: 10,
      paymentMethod: PaymentMethod.CARD,
    });
    expect(paymentRepository.save).toHaveBeenCalledTimes(1);
  });

  it('POST /device-api/pfand-returns: no cash payout', async () => {
    const { controller, pfandReturnRepository, gatewayService } =
      setup('de_new');
    await expectBlocked(
      controller.createPfandReturn(device, {
        lines: [{ pfandTypeId: 'pt-1', quantity: 2 }],
      }),
    );
    expect(pfandReturnRepository.save).not.toHaveBeenCalled();
    expect(gatewayService.sendOpenCashDrawer).not.toHaveBeenCalled();
  });

  it('POST /device-api/cash-drawer/open: no cash drawer', async () => {
    const { controller, gatewayService } = setup('de_new');
    await expectBlocked(controller.openCashDrawer(device));
    expect(gatewayService.sendOpenCashDrawer).not.toHaveBeenCalled();
  });

  it.each(['de_legacy', 'de_tse', 'at'] as const)(
    '%s: cash, drawer and Pfand payout work as before',
    async (kind) => {
      const { controller, paymentRepository, gatewayService } = setup(kind);
      await controller.createPayment(device, {
        orderId: 'order-1',
        amount: 10,
        paymentMethod: PaymentMethod.CASH,
      });
      await controller.openCashDrawer(device);
      expect(paymentRepository.save).toHaveBeenCalledTimes(1);
      expect(gatewayService.sendOpenCashDrawer).toHaveBeenCalled();
    },
  );

  it('POST /device-api/payments: an order closed without payment cannot be paid (409)', async () => {
    const closed = {
      ...openOrder(),
      closedWithoutPaymentAt: new Date(),
    } as Order;
    const { controller, paymentRepository } = setup('de_new', closed);
    await expect(
      controller.createPayment(device, {
        orderId: 'order-1',
        amount: 10,
        paymentMethod: PaymentMethod.CARD,
      }),
    ).rejects.toMatchObject({
      response: { reason: 'ORDER_CLOSED_WITHOUT_PAYMENT' },
    });
    expect(paymentRepository.save).not.toHaveBeenCalled();
  });

  it('GET /device-api/organization: tells the till about the mode', async () => {
    const { controller } = setup('de_new');
    const { data } = await controller.getOrganization(device);
    expect(data).toMatchObject({
      country: 'DE',
      operatingMode: 'full',
      operatingModeLegacy: false,
      tseActive: false,
      cashAllowed: false,
      pricesVisible: true,
    });
  });

  it('GET /device-api/organization: an active TSE allows cash', async () => {
    const { controller } = setup('de_tse');
    const { data } = await controller.getOrganization(device);
    expect(data).toMatchObject({ tseActive: true, cashAllowed: true });
  });
});

describe('Alle Funktionen in Deutschland ohne TSE — Sammelzahlung (PaymentsBatchService)', () => {
  function batch(kind: Kind) {
    const manager = {
      findOne: jest.fn(() => Promise.resolve(organization(kind))),
      find: jest.fn(() => Promise.resolve([])),
    };
    const service = new PaymentsBatchService(
      {
        transaction: (work: (m: unknown) => Promise<unknown>) => work(manager),
      } as never,
      {} as never,
      {} as never,
    );
    return { manager, service };
  }

  it('POST /device-api/payments/batch: rejects cash before locking orders', async () => {
    const { manager, service } = batch('de_new');
    await expectBlocked(
      service.payBatch(ORG_ID, 'device-1', {
        paymentMethod: PaymentMethod.CASH,
        orderIds: ['order-1'],
      } as BatchPaymentDto),
    );
    expect(manager.find).not.toHaveBeenCalled();
  });

  it('loads country, mode and legacy flag with the organization', async () => {
    const { manager, service } = batch('de_new');
    await service
      .payBatch(ORG_ID, 'device-1', {
        paymentMethod: PaymentMethod.CASH,
        orderIds: ['order-1'],
      } as BatchPaymentDto)
      .catch(() => undefined);
    const [entity, options] = manager.findOne.mock.calls[0] as unknown as [
      unknown,
      { select: Record<string, boolean> },
    ];
    expect(entity).toBe(Organization);
    expect(options.select).toMatchObject({
      country: true,
      operatingMode: true,
      operatingModeLegacy: true,
    });
  });
});

describe('Alle Funktionen in Deutschland ohne TSE — Verwaltung (PaymentsService)', () => {
  const user = { id: 'user-1' } as User;

  it('POST /organizations/:id/payments: rejects cash, accepts card', async () => {
    const paymentRepository = {
      create: jest.fn((p: Partial<Payment>) => ({ id: 'payment-1', ...p })),
      save: jest.fn((p: Payment) => Promise.resolve(p)),
      findOne: jest.fn(() =>
        Promise.resolve({
          id: 'payment-1',
          order: { organizationId: ORG_ID },
        }),
      ),
    };
    const service = new PaymentsService(
      paymentRepository as never,
      {
        findOne: jest.fn(() => Promise.resolve(openOrder())),
        save: jest.fn((o: Order) => Promise.resolve(o)),
      } as never,
      { save: jest.fn() } as never,
      { create: jest.fn(), save: jest.fn() } as never,
      { findOne: jest.fn(() => Promise.resolve({ role: 'admin' })) } as never,
      {
        findOne: jest.fn(() => Promise.resolve(organization('de_new'))),
      } as never,
      { handlePaymentReceived: jest.fn(() => Promise.resolve()) } as never,
    );
    await expectBlocked(
      service.create(
        ORG_ID,
        { orderId: 'order-1', amount: 10, paymentMethod: PaymentMethod.CASH },
        user,
      ),
    );
    expect(paymentRepository.save).not.toHaveBeenCalled();
    await service.create(
      ORG_ID,
      { orderId: 'order-1', amount: 10, paymentMethod: PaymentMethod.CARD },
      user,
    );
    expect(paymentRepository.save).toHaveBeenCalledTimes(1);
  });
});
