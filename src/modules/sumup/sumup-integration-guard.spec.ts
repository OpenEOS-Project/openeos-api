import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';

import { Device } from '../../database/entities/device.entity';
import { Event, EventStatus } from '../../database/entities/event.entity';
import { Organization } from '../../database/entities/organization.entity';
import { Payment, PaymentMethod } from '../../database/entities/payment.entity';
import { Order } from '../../database/entities/order.entity';
import { OrderItem } from '../../database/entities/order-item.entity';
import { User } from '../../database/entities/user.entity';
import {
  OrganizationRole,
  UserOrganization,
} from '../../database/entities/user-organization.entity';
import { redactResponse } from '../../common/utils/response-redaction.util';
import { DeviceApiController } from '../devices/device-api.controller';
import { OrderPrintService } from '../print-jobs/order-print.service';
import { SumUpApiService } from './sumup-api.service';
import { SumUpService } from './sumup.service';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

const ORG_ID = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a11';

function organization(enabled: boolean | undefined): Organization {
  return {
    id: ORG_ID,
    settings: {
      currency: 'EUR',
      sumup: { apiKey: 'sup_sk_test_1234', merchantCode: 'MC123' },
      ...(enabled === undefined
        ? {}
        : { integrations: { sumup: { enabled } } }),
    },
  } as unknown as Organization;
}

function sumupApiMock() {
  return {
    initiateCheckout: jest.fn(() => Promise.resolve({ data: 'ok' })),
    getReaderStatus: jest.fn(() => Promise.resolve({ status: 'ONLINE' })),
    getTransactionStatus: jest.fn(() => Promise.resolve({ status: 'PAID' })),
    terminateCheckout: jest.fn(() => Promise.resolve()),
    listReaders: jest.fn(() => Promise.resolve([])),
    pairReader: jest.fn(() => Promise.resolve({ id: 'r1' })),
    createOnlineCheckout: jest.fn(() =>
      Promise.resolve({ id: 'c1', checkoutUrl: 'https://pay' }),
    ),
  };
}

async function expectTestMode(call: Promise<unknown>): Promise<void> {
  await expect(call).rejects.toBeInstanceOf(BadRequestException);
  await expect(call).rejects.toMatchObject({
    response: { reason: 'SUMUP_DISABLED_IN_TEST_MODE' },
  });
}

async function expectDisabled(call: Promise<unknown>): Promise<void> {
  await expect(call).rejects.toBeInstanceOf(ForbiddenException);
  await expect(call).rejects.toMatchObject({
    response: { code: 'INTEGRATION_DISABLED' },
  });
}

describe('SumUp admin endpoints (SumUpService)', () => {
  function setup(
    enabled: boolean | undefined,
    events: { id: string; status: EventStatus }[] = [],
  ) {
    const organizationRepository = {
      findOne: jest.fn(() => Promise.resolve(organization(enabled))),
    } as unknown as Repository<Organization>;
    const userOrganizationRepository = {
      findOne: jest.fn(() =>
        Promise.resolve({ role: OrganizationRole.ADMIN } as UserOrganization),
      ),
    } as unknown as Repository<UserOrganization>;
    const api = sumupApiMock();
    const config = {
      get: jest.fn(() => undefined),
    } as unknown as ConfigService;
    const eventRepository = {
      find: jest.fn(() => Promise.resolve(events)),
    } as unknown as Repository<Event>;
    const service = new SumUpService(
      organizationRepository,
      userOrganizationRepository,
      api as unknown as SumUpApiService,
      config,
      eventRepository,
    );
    return { service, api };
  }

  const user = { id: 'user-1' } as User;

  it.each([[false], [undefined]])(
    'rejects reader, pairing, connection and checkout calls when enabled=%s',
    async (enabled) => {
      const { service, api } = setup(enabled);

      await expectDisabled(service.listReaders(ORG_ID, user));
      await expectDisabled(service.pairReader(ORG_ID, '1234', 'R', user));
      await expectDisabled(service.testConnection(ORG_ID, user));
      await expectDisabled(
        service.initiateCheckout(ORG_ID, 'r1', 10, 'EUR', user),
      );
      await expectDisabled(
        service.createOnlineCheckout(ORG_ID, 10, 'EUR', 'x', 'https://r'),
      );
      expect(api.listReaders).not.toHaveBeenCalled();
      expect(api.pairReader).not.toHaveBeenCalled();
      expect(api.initiateCheckout).not.toHaveBeenCalled();
      expect(api.createOnlineCheckout).not.toHaveBeenCalled();
    },
  );

  it('works when SumUp is enabled', async () => {
    const { service, api } = setup(true);

    await expect(service.listReaders(ORG_ID, user)).resolves.toEqual([]);
    expect(api.listReaders).toHaveBeenCalledWith('sup_sk_test_1234', 'MC123');
  });

  it('refuses a reader checkout while the event is in test mode', async () => {
    const { service, api } = setup(true, [
      { id: 'e1', status: EventStatus.TEST },
    ]);

    await expectTestMode(
      service.initiateCheckout(ORG_ID, 'r1', 10, 'EUR', user),
    );
    expect(api.initiateCheckout).not.toHaveBeenCalled();
    // Kartenleser verwalten bleibt im Testmodus moeglich.
    await expect(service.listReaders(ORG_ID, user)).resolves.toEqual([]);
  });

  it('starts a reader checkout for a live event', async () => {
    const { service, api } = setup(true, [
      { id: 'e1', status: EventStatus.ACTIVE },
    ]);

    await service.initiateCheckout(ORG_ID, 'r1', 10, 'EUR', user);
    expect(api.initiateCheckout).toHaveBeenCalledTimes(1);
  });
});

describe('SumUp device endpoints (DeviceApiController)', () => {
  const device = {
    id: 'device-1',
    organizationId: ORG_ID,
    settings: { sumupReaderId: 'reader-1' },
  } as unknown as Device;

  function setup(
    enabled: boolean | undefined,
    eventStatus: EventStatus = EventStatus.ACTIVE,
  ) {
    const organizationRepository = {
      findOne: jest.fn(() => Promise.resolve(organization(enabled))),
    };
    const event = { id: 'event-1', status: eventStatus };
    const eventRepository = {
      find: jest.fn(() => Promise.resolve([event])),
      findOne: jest.fn(() => Promise.resolve(event)),
    };
    const order = {
      id: 'order-1',
      eventId: 'event-1',
      orderNumber: 'A-1',
      total: 10,
      paidAmount: 0,
      paymentStatus: 'unpaid',
      items: [] as OrderItem[],
    } as unknown as Order;
    const orderRepository = {
      findOne: jest.fn(() => Promise.resolve(order)),
      save: jest.fn((o: Order) => Promise.resolve(o)),
    };
    const paymentRepository = {
      create: jest.fn((p: Partial<Payment>) => ({ id: 'payment-1', ...p })),
      save: jest.fn((p: Payment) => Promise.resolve(p)),
    };
    const orderPrintService = {
      handlePaymentReceived: jest.fn(() => Promise.resolve()),
    } as unknown as OrderPrintService;
    const api = sumupApiMock();
    const none = undefined as never;
    const controller = new DeviceApiController(
      organizationRepository as unknown as Repository<Organization>,
      eventRepository as unknown as Repository<Event>,
      none,
      none,
      orderRepository as unknown as Repository<Order>,
      none,
      paymentRepository as unknown as Repository<Payment>,
      none,
      none,
      none,
      none,
      api as unknown as SumUpApiService,
      none,
      none,
      none,
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
    );
    return { controller, api, paymentRepository };
  }

  it.each([[false], [undefined]])(
    'rejects checkout, status and terminate when enabled=%s',
    async (enabled) => {
      const { controller, api } = setup(enabled);

      await expectDisabled(
        controller.initiateSumupCheckout(device, { amount: 10 }),
      );
      await expectDisabled(controller.getSumupStatus(device, 'tx-1'));
      await expectDisabled(controller.terminateSumupCheckout(device));
      expect(api.initiateCheckout).not.toHaveBeenCalled();
      expect(api.getTransactionStatus).not.toHaveBeenCalled();
      expect(api.terminateCheckout).not.toHaveBeenCalled();
    },
  );

  it('starts a checkout when SumUp is enabled', async () => {
    const { controller, api } = setup(true);

    await expect(
      controller.initiateSumupCheckout(device, { amount: 10 }),
    ).resolves.toEqual({ data: { data: 'ok' } });
    expect(api.initiateCheckout).toHaveBeenCalledWith(
      'sup_sk_test_1234',
      'MC123',
      'reader-1',
      { amount: 10, currency: 'EUR' },
    );
  });

  it('refuses to book a SumUp terminal payment while SumUp is disabled', async () => {
    const { controller, paymentRepository } = setup(false);

    await expectDisabled(
      controller.createPayment(device, {
        orderId: 'order-1',
        amount: 10,
        paymentMethod: PaymentMethod.SUMUP_TERMINAL,
      }),
    );
    expect(paymentRepository.save).not.toHaveBeenCalled();
  });

  it.each([[PaymentMethod.CASH], [PaymentMethod.CARD]])(
    'still books %s payments while SumUp is disabled',
    async (paymentMethod) => {
      const { controller, paymentRepository } = setup(false);

      await controller.createPayment(device, {
        orderId: 'order-1',
        amount: 10,
        paymentMethod,
      });
      expect(paymentRepository.save).toHaveBeenCalledTimes(1);
    },
  );

  it('hands the integration state to the POS, with credentials masked', async () => {
    const { controller } = setup(false);

    const response = redactResponse(await controller.getOrganization(device));

    expect(response.data.settings.integrations).toEqual({
      sumup: { enabled: false },
    });
    expect(response.data.settings.sumup?.apiKey).toBe('****1234');
  });

  it('test mode: no reader checkout, status and abort stay reachable', async () => {
    const { controller, api } = setup(true, EventStatus.TEST);

    await expectTestMode(
      controller.initiateSumupCheckout(device, { amount: 10 }),
    );
    expect(api.initiateCheckout).not.toHaveBeenCalled();
    await controller.getSumupStatus(device, 'tx-1');
    await controller.terminateSumupCheckout(device);
    expect(api.terminateCheckout).toHaveBeenCalledTimes(1);
  });

  it('test mode: refuses to book a SumUp terminal payment for a test order', async () => {
    const { controller, paymentRepository } = setup(true, EventStatus.TEST);

    await expectTestMode(
      controller.createPayment(device, {
        orderId: 'order-1',
        amount: 10,
        paymentMethod: PaymentMethod.SUMUP_TERMINAL,
      }),
    );
    expect(paymentRepository.save).not.toHaveBeenCalled();
  });

  it.each([[PaymentMethod.CASH], [PaymentMethod.CARD]])(
    'test mode: still books %s payments',
    async (paymentMethod) => {
      const { controller, paymentRepository } = setup(true, EventStatus.TEST);

      await controller.createPayment(device, {
        orderId: 'order-1',
        amount: 10,
        paymentMethod,
      });
      expect(paymentRepository.save).toHaveBeenCalledTimes(1);
    },
  );

  it('books a SumUp terminal payment when SumUp is enabled', async () => {
    const { controller, paymentRepository } = setup(true);

    await controller.createPayment(device, {
      orderId: 'order-1',
      amount: 10,
      paymentMethod: PaymentMethod.SUMUP_TERMINAL,
    });
    expect(paymentRepository.save).toHaveBeenCalledTimes(1);
  });
});
