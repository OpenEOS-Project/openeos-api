import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { Repository } from 'typeorm';

import { tseStatus, resetTseStatus } from '../../common/utils/tse.util';
import type { Device } from '../../database/entities/device.entity';
import { EventStatus, type Event } from '../../database/entities/event.entity';
import type { Order } from '../../database/entities/order.entity';
import type { OrderItem } from '../../database/entities/order-item.entity';
import type { Organization } from '../../database/entities/organization.entity';
import {
  PaymentMethod,
  type Payment,
} from '../../database/entities/payment.entity';
import type { PfandReturn } from '../../database/entities/pfand-return.entity';
import type { PfandType } from '../../database/entities/pfand-type.entity';
import type { User } from '../../database/entities/user.entity';
import { DeviceApiController } from '../devices/device-api.controller';
import type { GatewayService } from '../gateway/gateway.service';
import {
  PaymentsBatchService,
  type SettledBatch,
} from '../payments/payments-batch.service';
import { PaymentsService } from '../payments/payments.service';
import { PfandReturnsService } from '../pfand-types/pfand-returns.service';
import type { OrderPrintService } from '../print-jobs/order-print.service';
import { RefundsService } from '../refunds/refunds.service';
import type { TseSigningService } from './tse-signing.service';
import type { TseReceiptView } from './tse-view';

/**
 * Jeder Weg, auf dem Geld in OpenEOS verbucht wird, signiert ueber die
 * Cloud-TSE — und zwar nach dem Speichern, vor dem Bon; der Bon und die
 * Antwort tragen die TSE-Daten. Die Signatur selbst (signed/failed/
 * training) testet tse-signing.service.spec.ts.
 */

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

const ORG_ID = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a99';

function view(
  kind: TseReceiptView['kind'],
  status: TseReceiptView['status'] = 'signed',
): TseReceiptView {
  return {
    id: `tx-${kind}`,
    kind,
    status,
    training: status === 'training',
    notice: status === 'failed' ? 'TSE ausgefallen' : null,
    processType: kind === 'order' ? 'Bestellung-V1' : 'Kassenbeleg-V1',
    processData: 'Beleg^…',
    serialNumber: 'ff',
    clientId: 'OEOS-1',
    bonNumber: null,
    transactionNumber: 1,
    signatureCounter: 2,
    startTime: null,
    finishTime: null,
    signatureValue: null,
    signatureAlgorithm: null,
    logTimeFormat: null,
    publicKey: null,
    qrCode: null,
    errorCode: null,
    terminal: 'device-1',
    orderId: null,
    paymentId: null,
    refundId: null,
    pfandReturnId: null,
    createdAt: new Date().toISOString(),
  };
}

function signingMock() {
  return {
    signPayment: jest.fn((id: string) =>
      Promise.resolve({ ...view('receipt'), id: `tx-${id}` }),
    ),
    signPayments: jest.fn((ids: string[]) =>
      Promise.resolve(
        new Map(ids.map((id) => [id, { ...view('receipt'), id: `tx-${id}` }])),
      ),
    ),
    signZeroReceipt: jest.fn(() => Promise.resolve(view('receipt'))),
    signRefund: jest.fn(() => Promise.resolve(view('refund', 'failed'))),
    signPfandReturn: jest.fn(() =>
      Promise.resolve(view('deposit_return', 'training')),
    ),
    signOrderCreated: jest.fn(() => Promise.resolve(view('order'))),
    signOrderChange: jest.fn(() => Promise.resolve(view('order_cancellation'))),
    forPayment: jest.fn(() => Promise.resolve(view('receipt'))),
  };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

beforeEach(() => {
  tseStatus.isActive = () => true;
});
afterEach(() => resetTseStatus());

function organization(): Organization {
  return {
    id: ORG_ID,
    country: 'DE',
    operatingMode: 'full',
    operatingModeLegacy: false,
    tseActive: true,
    settings: { currency: 'EUR', integrations: { tse: { enabled: true } } },
  } as unknown as Organization;
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

describe('Kasse (DeviceApiController)', () => {
  const device = {
    id: 'device-1',
    organizationId: ORG_ID,
    settings: {},
  } as unknown as Device;

  function setup() {
    const signing = signingMock();
    const order = openOrder();
    const paymentRepository = {
      create: jest.fn((p: Partial<Payment>) => ({ id: 'payment-1', ...p })),
      save: jest.fn((p: Payment) => Promise.resolve(p)),
    };
    const orderPrintService = {
      handlePaymentReceived: jest.fn(() => Promise.resolve()),
    };
    const event = { id: 'event-1', status: EventStatus.ACTIVE };
    const gatewayService = {
      sendOpenCashDrawer: jest.fn(),
      notifyPfandReturned: jest.fn(),
    };
    const pfandReturnsService = new PfandReturnsService(
      {
        manager: {
          findOne: jest.fn(() => Promise.resolve(organization())),
          transaction: jest.fn(
            (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> =>
              fn({
                query: jest.fn(() => Promise.resolve([{ max: 4 }])),
                findOne: jest.fn(() => Promise.resolve(null)),
                save: (_entity: unknown, row: PfandReturn) =>
                  Promise.resolve(row),
              }),
          ),
        },
        create: jest.fn((data: Partial<PfandReturn>) => ({
          id: 'pr-1',
          ...data,
        })),
        save: jest.fn((row: PfandReturn) => Promise.resolve(row)),
      } as unknown as Repository<PfandReturn>,
      {
        find: jest.fn(() =>
          Promise.resolve([{ id: 'pt-1', name: 'Becher', amount: 2 }]),
        ),
      } as unknown as Repository<PfandType>,
      gatewayService as unknown as GatewayService,
      signing as unknown as TseSigningService,
    );
    const none = undefined as never;
    const controller = new DeviceApiController(
      { findOne: jest.fn(() => Promise.resolve(organization())) } as never,
      {
        find: jest.fn(() => Promise.resolve([event])),
        findOne: jest.fn(() => Promise.resolve(event)),
      } as unknown as Repository<Event>,
      none,
      none,
      {
        findOne: jest.fn(() => Promise.resolve(order)),
        save: jest.fn((o: Order) => Promise.resolve(o)),
      } as never,
      { save: jest.fn((i: OrderItem) => Promise.resolve(i)) } as never,
      paymentRepository as never,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      gatewayService as never,
      orderPrintService as unknown as OrderPrintService,
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
      signing as unknown as TseSigningService,
    );
    return { controller, signing, orderPrintService, paymentRepository };
  }

  it('POST /device-api/payments signs before printing and returns tse', async () => {
    const { controller, signing, orderPrintService, paymentRepository } =
      setup();
    const result = await controller.createPayment(device, {
      orderId: 'order-1',
      amount: 10,
      paymentMethod: PaymentMethod.CASH,
    });
    expect(paymentRepository.save).toHaveBeenCalled();
    expect(signing.signPayment).toHaveBeenCalledWith('payment-1');
    const printArgs = orderPrintService.handlePaymentReceived.mock
      .calls[0] as unknown as [string, { tse: TseReceiptView }];
    expect(printArgs[1].tse.id).toBe('tx-payment-1');
    expect((result.data as unknown as { tse: TseReceiptView }).tse.id).toBe(
      'tx-payment-1',
    );
    expect(signing.signPayment.mock.invocationCallOrder[0]).toBeLessThan(
      orderPrintService.handlePaymentReceived.mock.invocationCallOrder[0],
    );
  });

  it('POST /device-api/payments/split signs the partial payment', async () => {
    const { controller, signing, orderPrintService } = setup();
    const result = await controller.createSplitPayment(device, {
      orderId: 'order-1',
      amount: 5,
      paymentMethod: PaymentMethod.CARD,
      items: [{ orderItemId: 'item-1', quantity: 1 }],
    });
    expect(signing.signPayment).toHaveBeenCalledWith('payment-1');
    const printArgs = orderPrintService.handlePaymentReceived.mock
      .calls[0] as unknown as [string, { tse: TseReceiptView }];
    expect(printArgs[1].tse).toBeTruthy();
    expect((result.data as { tse: TseReceiptView }).tse).toBeTruthy();
  });

  it('POST /device-api/pfand-returns signs the payout', async () => {
    const { controller, signing } = setup();
    const result = await controller.createPfandReturn(device, {
      lines: [{ pfandTypeId: 'pt-1', quantity: 2 }],
    });
    expect(signing.signPfandReturn).toHaveBeenCalledTimes(1);
    expect((result.data as { tse: TseReceiptView }).tse.kind).toBe(
      'deposit_return',
    );
    // Belegnummer je Tag fortlaufend, Satz der Pfandart (Standard 19 %).
    expect(result.data.returnNumber).toMatch(/^P-\d{8}-0005$/);
    expect(result.data.lines[0].vatRate).toBe(19);
  });
});

describe('Sammelzahlung, Tisch, Bestellung mit Zahlung (PaymentsBatchService.afterCommit)', () => {
  it('signs every payment and zero order before printing; payments carry tse', async () => {
    const signing = signingMock();
    const print = { handlePaymentReceived: jest.fn(() => Promise.resolve()) };
    const gateway = {
      notifyOrderUpdated: jest.fn(),
      notifyPaymentReceived: jest.fn(),
    };
    const service = new PaymentsBatchService(
      {} as never,
      gateway as never,
      print as never,
      signing as unknown as TseSigningService,
    );
    const orders = [
      {
        id: 'o1',
        eventId: 'e',
        orderNumber: '1',
        paymentStatus: 'paid',
        paidAmount: 5,
        total: 5,
      },
      {
        id: 'o2',
        eventId: 'e',
        orderNumber: '2',
        paymentStatus: 'paid',
        paidAmount: 7,
        total: 7,
      },
      {
        id: 'o3',
        eventId: 'e',
        orderNumber: '3',
        paymentStatus: 'paid',
        paidAmount: 0,
        total: 0,
      },
    ] as unknown as Order[];
    const outcome: SettledBatch = {
      orders,
      payments: [
        {
          id: 'p1',
          orderId: 'o1',
          amount: 5,
          paymentMethod: 'cash',
          metadata: {},
        },
        {
          id: 'p2',
          orderId: 'o2',
          amount: 7,
          paymentMethod: 'cash',
          metadata: {},
        },
      ] as unknown as Payment[],
      totalPaid: 12,
      change: 0,
      adjusted: new Map(),
      settledWithoutPayment: ['o3'],
    };
    await service.afterCommit(ORG_ID, outcome, { deviceId: 'device-1' });
    expect(signing.signPayments).toHaveBeenCalledWith(['p1', 'p2']);
    expect(signing.signZeroReceipt).toHaveBeenCalledWith('o3', {
      terminal: 'device-1',
      waiterId: null,
      userId: null,
    });
    expect(outcome.payments.map((p) => p.tse?.id)).toEqual(['tx-p1', 'tx-p2']);
    expect(outcome.zeroReceipts).toHaveLength(1);
    const printed = print.handlePaymentReceived.mock.calls.map(
      (call) =>
        (call as unknown as [string, { tse: TseReceiptView }])[1].tse.id,
    );
    expect(printed).toEqual(['tx-p1', 'tx-p2']);
  });
});

describe('Verwaltung (PaymentsService)', () => {
  it('POST /organizations/:id/payments signs and returns tse', async () => {
    const signing = signingMock();
    const print = { handlePaymentReceived: jest.fn(() => Promise.resolve()) };
    const service = new PaymentsService(
      {
        create: jest.fn((p: Partial<Payment>) => ({ id: 'payment-9', ...p })),
        save: jest.fn((p: Payment) => Promise.resolve(p)),
        findOne: jest.fn(() =>
          Promise.resolve({
            id: 'payment-9',
            order: { organizationId: ORG_ID },
          }),
        ),
      } as never,
      {
        findOne: jest.fn(() => Promise.resolve(openOrder())),
        save: jest.fn((o: Order) => Promise.resolve(o)),
      } as never,
      { save: jest.fn() } as never,
      { create: jest.fn(), save: jest.fn() } as never,
      { findOne: jest.fn(() => Promise.resolve({ role: 'admin' })) } as never,
      { findOne: jest.fn(() => Promise.resolve(organization())) } as never,
      print as never,
      signing as unknown as TseSigningService,
    );
    const result = await service.create(
      ORG_ID,
      { orderId: 'order-1', amount: 10, paymentMethod: PaymentMethod.CASH },
      { id: 'user-1' } as User,
    );
    expect(signing.signPayment).toHaveBeenCalledWith('payment-9');
    expect((result as unknown as { tse: TseReceiptView }).tse.id).toBe(
      'tx-payment-9',
    );
    const printArgs = print.handlePaymentReceived.mock.calls[0] as unknown as [
      string,
      { tse: TseReceiptView },
    ];
    expect(printArgs[1].tse.id).toBe('tx-payment-9');
  });
});

describe('Erstattung, Storno (RefundsService)', () => {
  function service(
    signing: ReturnType<typeof signingMock>,
    print: Record<string, jest.Mock>,
  ) {
    return new RefundsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      print as never,
      {
        sendOpenCashDrawer: jest.fn(),
        notifyOrderItemStatusChanged: jest.fn(),
        notifyKitchenOrderCancelled: jest.fn(),
        notifyProductUpdated: jest.fn(),
      } as never,
      {} as never,
      signing as unknown as TseSigningService,
    );
  }

  it('signs each refund as counter receipt before printing it', async () => {
    const signing = signingMock();
    const print = { printRefundReceipt: jest.fn(() => Promise.resolve(true)) };
    const refunds = [
      { id: 'r1', paymentMethod: 'cash' },
      { id: 'r2', paymentMethod: 'card' },
    ];
    await (
      service(signing, print) as unknown as {
        afterRefund: (actor: unknown, outcome: unknown) => Promise<void>;
      }
    ).afterRefund(
      {
        organizationId: ORG_ID,
        deviceId: 'device-1',
        cashDrawerPrinterId: null,
      },
      { order: openOrder(), refunds, cancelled: null, reason: null },
    );
    expect(signing.signRefund).toHaveBeenCalledTimes(2);
    expect(print.printRefundReceipt).toHaveBeenCalledTimes(2);
    const printArgs = print.printRefundReceipt.mock.calls[0] as unknown as [
      string,
      { tse: TseReceiptView },
    ];
    expect(printArgs[1].tse.notice).toBe('TSE ausgefallen');
    expect((refunds[0] as { tse?: TseReceiptView }).tse?.kind).toBe('refund');
  });

  it('signs cancelled positions of a signed order as Bestellung-V1 with negative quantities', () => {
    const signing = signingMock();
    const print = {
      printCancellationTickets: jest.fn(() => Promise.resolve()),
    };
    const item = {
      id: 'i1',
      productName: 'Bier',
      unitPrice: 4.5,
      optionsPrice: 0,
    };
    (
      service(signing, print) as unknown as {
        afterCancellation: (
          a: unknown,
          o: unknown,
          c: unknown,
          r: unknown,
        ) => void;
      }
    ).afterCancellation(
      { organizationId: ORG_ID, deviceId: 'device-1', userId: null },
      openOrder(),
      {
        lines: [
          {
            item,
            cancelled: { id: 'i1-c' },
            quantity: 2,
            previousStatus: 'pending',
          },
        ],
        orderCancelled: false,
        restockedProducts: [],
      },
      null,
    );
    expect(signing.signOrderChange).toHaveBeenCalledWith(
      'order-1',
      [{ item, quantity: -2 }],
      {
        terminal: 'device-1',
        userId: null,
        waiterId: null,
        operatorName: undefined,
      },
    );
  });
});

describe('Schutz gegen neue unsignierte Zahlungswege', () => {
  const SRC = path.resolve(__dirname, '../..');
  /**
   * Dateien, die eine Zahlung auf CAPTURED setzen (oder so anlegen), und
   * wie sie zur TSE stehen. Ein neuer Zahlungsweg muss hier eingetragen
   * werden — und signieren, ausser er ist Online-Vorkasse ohne Barzahlung
   * vor Ort (BMF-FAQ Anwendungsbereich 2/10, fiskaly-spec.md F6).
   */
  const PATHS: Record<string, 'signed' | 'online_prepaid' | 'read_only'> = {
    'modules/payments/payments-batch.service.ts': 'signed',
    'modules/payments/payments.service.ts': 'signed',
    'modules/devices/device-api.controller.ts': 'signed',
    'modules/online-orders/online-orders.service.ts': 'online_prepaid',
    'modules/events/events-shop-checkout.controller.ts': 'online_prepaid',
    'modules/refunds/refunds.service.ts': 'read_only',
    'modules/refunds/order-history.service.ts': 'read_only',
    'modules/reports/reports.service.ts': 'read_only',
    'modules/devices/devices.service.ts': 'read_only',
    'database/entities/payment.entity.ts': 'read_only',
  };

  function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return files(full);
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
        ? [full]
        : [];
    });
  }

  it('every file that captures payments is known, and the signed ones call the TSE', () => {
    const capturing = files(SRC)
      .filter((file) =>
        fs
          .readFileSync(file, 'utf8')
          .includes('PaymentTransactionStatus.CAPTURED'),
      )
      .map((file) => path.relative(SRC, file).split(path.sep).join('/'));
    expect(capturing.filter((file) => !(file in PATHS))).toEqual([]);
    for (const [file, kind] of Object.entries(PATHS)) {
      if (kind !== 'signed') continue;
      const source = fs.readFileSync(path.join(SRC, file), 'utf8');
      expect({ file, signs: /tseSigning\??\.sign/.test(source) }).toEqual({
        file,
        signs: true,
      });
    }
  });

  it('refunds, Pfand payouts and admin order changes sign too', () => {
    const expectations: Array<[string, RegExp]> = [
      ['modules/refunds/refunds.service.ts', /tseSigning\??\.signRefund/],
      ['modules/refunds/refunds.service.ts', /tseSigning\??\.signOrderChange/],
      [
        'modules/pfand-types/pfand-returns.service.ts',
        /tseSigning\??\.signPfandReturn/,
      ],
      ['modules/orders/orders.service.ts', /tseSigning\??\.signOrderCreated/],
      ['modules/orders/orders.service.ts', /tseSigning\??\.signOrderChange/],
      [
        'modules/devices/device-api.controller.ts',
        /tseSigning\??\.signOrderCreated/,
      ],
      [
        'modules/devices/device-api.controller.ts',
        /tseSigning\??\.signZeroReceipt/,
      ],
      ['modules/devices/device-api.controller.ts', /tseSigning\??\.forPayment/],
    ];
    for (const [file, pattern] of expectations) {
      const source = fs.readFileSync(path.join(SRC, file), 'utf8');
      expect({
        file,
        pattern: String(pattern),
        found: pattern.test(source),
      }).toEqual({
        file,
        pattern: String(pattern),
        found: true,
      });
    }
  });
});
