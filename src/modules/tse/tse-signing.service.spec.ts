import { Logger } from '@nestjs/common';

import { OrderItemStatus } from '../../database/entities/order-item.entity';
import type { TseTransaction } from '../../database/entities/tse-transaction.entity';
import {
  SwissbitTimeoutError,
  SwissbitUnavailableError,
  SwissbitRequestError,
} from './swissbit/swissbit.errors';
import { TseSigningService } from './tse-signing.service';
import {
  TSE_FAILED_NOTICE,
  TSE_TRAINING_NOTICE,
  tsePrintBlock,
} from './tse-view';

const ORG = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a99';
const UNIT = {
  id: 'unit-1',
  organizationId: ORG,
  state: 'active',
  serialNumber:
    'd7201aa6d1ba08c78bbc7d10f9eba5bb0199698092045b10ff72ca3d5dafe6c7',
  clientId: 'OEOS-7D0C7A524F43',
  publicKey: 'BHhWOeis=',
  signatureAlgorithm: 'ecdsa-plain-SHA256',
  logTimeFormat: 'unixTime',
};

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

function order(extra: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    organizationId: ORG,
    eventId: 'event-1',
    orderNumber: 'A-1',
    isTest: false,
    tableId: null,
    tableNumber: null,
    fulfillmentType: 'counter_pickup',
    discountAmount: 0,
    tipAmount: 0,
    total: 11.9,
    items: [
      {
        id: 'i1',
        productName: 'Bier',
        quantity: 2,
        unitPrice: 4.5,
        optionsPrice: 0,
        totalPrice: 9,
        taxRate: 19,
        status: OrderItemStatus.PENDING,
        depositAmount: 0,
      },
      {
        id: 'i2',
        productName: 'Brezel',
        quantity: 1,
        unitPrice: 2.9,
        optionsPrice: 0,
        totalPrice: 2.9,
        taxRate: 7,
        status: OrderItemStatus.PENDING,
        depositAmount: 0,
      },
    ],
    ...extra,
  };
}

function setup(
  options: {
    active?: boolean;
    vatExempt?: boolean;
    order?: Record<string, unknown>;
    start?: () => Promise<unknown>;
    finish?: () => Promise<unknown>;
    budgetMs?: number;
  } = {},
) {
  const rows = new Map<string, TseTransaction>();
  let n = 0;
  const txRepository = {
    create: jest.fn(
      (data: Partial<TseTransaction>) => ({ ...data }) as TseTransaction,
    ),
    save: jest.fn((row: TseTransaction) => {
      const saved = {
        ...row,
        id: row.id ?? `tx-${++n}`,
        createdAt: new Date(),
      } as TseTransaction;
      rows.set(saved.id, saved);
      return Promise.resolve(saved);
    }),
    update: jest.fn((id: string, patch: Partial<TseTransaction>) => {
      rows.set(id, { ...rows.get(id)!, ...patch });
      return Promise.resolve();
    }),
    findOne: jest.fn(() => Promise.resolve(null)),
    exists: jest.fn(() => Promise.resolve(true)),
    find: jest.fn(() => Promise.resolve([])),
    // Namens-Snapshot fuer BEDIENER_NAME (Bedienung bzw. Mitglied).
    manager: {
      query: jest.fn((sql: string) =>
        Promise.resolve(
          sql.includes('FROM waiters')
            ? [{ name: 'Anna Berger' }]
            : [{ name: 'Markus Maier' }],
        ),
      ),
    },
  };
  const theOrder = order(options.order);
  const payment = {
    id: 'pay-1',
    orderId: 'order-1',
    amount: 11.9,
    paymentMethod: 'cash',
    metadata: {},
    itemPayments: [],
    processedByDeviceId: 'device-1',
    processedByUserId: null,
  };
  const startResponse = {
    transactionNumber: 17,
    signatureCreationTime: 1793716174,
    signatureCounter: 40,
    signatureValue: 'start-sig',
  };
  const finishResponse = {
    transactionNumber: 17,
    signatureCreationTime: 1793716175,
    signatureCounter: 41,
    signatureValue: 'finish-sig',
  };
  const client = {
    startTransaction: jest.fn(
      options.start ??
        (() =>
          Promise.resolve({
            value: startResponse,
            requestId: 'req-start',
            durationMs: 150,
          })),
    ),
    finishTransaction: jest.fn(
      options.finish ??
        (() =>
          Promise.resolve({
            value: finishResponse,
            requestId: 'req-finish',
            durationMs: 150,
          })),
    ),
  };
  const outages = {
    recordFailure: jest.fn(() => Promise.resolve()),
    recordSuccess: jest.fn(() => Promise.resolve()),
  };
  const units = {
    get: jest.fn(() =>
      Promise.resolve(
        options.active === false
          ? null
          : {
              unit: UNIT,
              credentials: {
                serialNumber: UNIT.serialNumber,
                accessToken: 't',
              },
            },
      ),
    ),
    invalidate: jest.fn(),
  };
  const service = new TseSigningService(
    txRepository as never,
    { find: jest.fn(() => Promise.resolve([UNIT])) } as never,
    { findOne: jest.fn(() => Promise.resolve(payment)) } as never,
    { findOne: jest.fn(() => Promise.resolve(theOrder)) } as never,
    {
      findOne: jest.fn(() =>
        Promise.resolve({
          id: ORG,
          settings: { vatExempt: options.vatExempt ?? false },
        }),
      ),
    } as never,
    units as never,
    { client } as never,
    outages as never,
    {
      settings: {
        timeouts: {
          transactionMs: 5000,
          signBudgetMs: options.budgetMs ?? 8000,
          adminMs: 15000,
        },
      },
    } as never,
  );
  return { service, client, rows, outages, units, txRepository, payment };
}

describe('TseSigningService — Kassenbeleg einer Zahlung', () => {
  it('signs start → finish with Kassenbeleg-V1 and stores the TSE data', async () => {
    const { service, client, rows, outages } = setup();
    const view = await service.signPayment('pay-1');

    expect(client.startTransaction).toHaveBeenCalledTimes(1);
    const [, startReq] = client.startTransaction.mock.calls[0] as unknown as [
      unknown,
      { processData: string; processType: string; clientId: string },
    ];
    expect(startReq).toMatchObject({
      processType: 'Kassenbeleg-V1',
      processData: '',
      clientId: UNIT.clientId,
    });
    const [, number, finishReq] = client.finishTransaction.mock
      .calls[0] as unknown as [unknown, number, { processData: string }];
    expect(number).toBe(17);
    expect(finishReq.processData).toBe(
      'Beleg^9.00_2.90_0.00_0.00_0.00^11.90:Bar',
    );

    expect(view).toMatchObject({
      status: 'signed',
      training: false,
      notice: null,
      transactionNumber: 17,
      signatureCounter: 41,
      signatureValue: 'finish-sig',
      startTime: '2026-11-03T14:29:34.000Z',
      finishTime: '2026-11-03T14:29:35.000Z',
      serialNumber: UNIT.serialNumber,
      clientId: UNIT.clientId,
      signatureAlgorithm: 'ecdsa-plain-SHA256',
      logTimeFormat: 'unixTime',
    });
    expect(view!.qrCode).toBe(
      `V0;${UNIT.clientId};Kassenbeleg-V1;Beleg^9.00_2.90_0.00_0.00_0.00^11.90:Bar;17;41;2026-11-03T14:29:34.000Z;2026-11-03T14:29:35.000Z;ecdsa-plain-SHA256;unixTime;finish-sig;BHhWOeis=`,
    );
    const stored = [...rows.values()][0];
    expect(stored).toMatchObject({
      status: 'signed',
      kind: 'receipt',
      paymentId: 'pay-1',
      orderId: 'order-1',
      terminal: 'device-1',
      amount: '11.90',
      startRequestId: 'req-start',
      finishRequestId: 'req-finish',
    });
    expect(outages.recordSuccess).toHaveBeenCalledWith(ORG, 'unit-1');
    expect(outages.recordFailure).not.toHaveBeenCalled();
  });

  it('puts everything into the 0 % slot for a VAT-exempt club and marks card as Unbar', async () => {
    const { service, client, payment } = setup({ vatExempt: true });
    payment.paymentMethod = 'sumup_terminal';
    await service.signPayment('pay-1');
    const [, , finishReq] = client.finishTransaction.mock
      .calls[0] as unknown as [unknown, number, { processData: string }];
    expect(finishReq.processData).toBe(
      'Beleg^0.00_0.00_0.00_0.00_11.90^11.90:Unbar',
    );
  });

  it('signs test-mode bookings as AVTraining with status training (never deleted)', async () => {
    const { service, client, rows } = setup({ order: { isTest: true } });
    const view = await service.signPayment('pay-1');
    const [, , finishReq] = client.finishTransaction.mock
      .calls[0] as unknown as [unknown, number, { processData: string }];
    expect(finishReq.processData).toMatch(/^AVTraining\^/);
    expect(view).toMatchObject({
      status: 'training',
      training: true,
      notice: TSE_TRAINING_NOTICE,
    });
    expect([...rows.values()][0]).toMatchObject({
      status: 'training',
      training: true,
    });
    expect(tsePrintBlock(view)).toMatchObject({
      training: true,
      failed: false,
    });
  });

  it('never throws on a TSE outage: failed transaction, outage recorded, receipt notice', async () => {
    const { service, rows, outages, client } = setup({
      start: () =>
        Promise.reject(
          new SwissbitUnavailableError({
            operation: 'startTransaction',
            status: 503,
            errorCode: 'E_MAINTENANCE_IN_PROGRESS',
            message: 'maintenance',
            requestId: 'req-x',
          }),
        ),
    });
    const view = await service.signPayment('pay-1');
    // Ein zweiter Versuch, weil Swissbit sicher nichts verarbeitet hat.
    expect(client.startTransaction).toHaveBeenCalledTimes(2);
    expect(client.finishTransaction).not.toHaveBeenCalled();
    expect(view).toMatchObject({
      status: 'failed',
      notice: TSE_FAILED_NOTICE,
      qrCode: null,
      signatureValue: null,
      errorCode: 'E_MAINTENANCE_IN_PROGRESS',
    });
    expect([...rows.values()][0]).toMatchObject({
      status: 'failed',
      errorCode: 'E_MAINTENANCE_IN_PROGRESS',
    });
    expect(outages.recordFailure).toHaveBeenCalledWith(
      ORG,
      'unit-1',
      'E_MAINTENANCE_IN_PROGRESS',
      expect.any(String),
    );
    expect(tsePrintBlock(view)).toMatchObject({
      failed: true,
      notice: 'TSE nicht erreichbar – Beleg ohne Signatur',
    });
  });

  it('does not retry a timeout (the TSE may have processed it) and keeps the transaction number', async () => {
    const { service, client, rows } = setup({
      finish: () =>
        Promise.reject(
          new SwissbitTimeoutError({
            operation: 'finishTransaction',
            status: null,
            errorCode: 'E_TIMEOUT',
            message: 'no response',
            requestId: 'req-y',
          }),
        ),
    });
    const view = await service.signPayment('pay-1');
    expect(client.finishTransaction).toHaveBeenCalledTimes(1);
    expect(view?.status).toBe('failed');
    expect([...rows.values()][0]).toMatchObject({
      status: 'failed',
      errorCode: 'E_TIMEOUT',
      transactionNumber: '17',
      finishRequestId: 'req-y',
    });
  });

  it('gives up before finish when the sign budget is exhausted (no late finish)', async () => {
    const { service, client } = setup({
      budgetMs: 500,
      start: () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                value: {
                  transactionNumber: 1,
                  signatureCreationTime: 1,
                  signatureCounter: 1,
                  signatureValue: 's',
                },
                requestId: 'r',
                durationMs: 400,
              }),
            400,
          ),
        ),
    });
    const view = await service.signPayment('pay-1');
    expect(client.finishTransaction).not.toHaveBeenCalled();
    expect(view).toMatchObject({ status: 'failed', errorCode: 'E_TIMEOUT' });
  });

  it('does not open an outage when the TSE was deactivated elsewhere', async () => {
    const { service, outages, units } = setup({
      start: () =>
        Promise.reject(
          new SwissbitRequestError({
            operation: 'startTransaction',
            status: 400,
            errorCode: 'E_TSE_DISABLED',
            message: 'disabled',
            requestId: 'r',
          }),
        ),
    });
    const view = await service.signPayment('pay-1');
    expect(view?.status).toBe('failed');
    expect(outages.recordFailure).not.toHaveBeenCalled();
    expect(units.invalidate).toHaveBeenCalledWith(ORG);
  });

  it('does nothing without an active TSE (sale unchanged)', async () => {
    const { service, client, txRepository } = setup({ active: false });
    await expect(service.signPayment('pay-1')).resolves.toBeNull();
    expect(client.startTransaction).not.toHaveBeenCalled();
    expect(txRepository.save).not.toHaveBeenCalled();
  });
});

describe('TseSigningService — Bediener (DSFinV-K BEDIENER)', () => {
  it('stores the server and a name snapshot with the receipt', async () => {
    const { service, rows, payment } = setup();
    Object.assign(payment, { processedByWaiterId: 'w-1' });
    await service.signPayment('pay-1');
    const [tx] = [...rows.values()];
    expect(tx).toMatchObject({ waiterId: 'w-1', operatorName: 'Anna Berger' });
  });

  it('takes the member name when a member was logged in, and nothing without a person', async () => {
    const { service, rows, payment } = setup();
    Object.assign(payment, { processedByUserId: 'u-1' });
    await service.signPayment('pay-1');
    expect([...rows.values()][0]).toMatchObject({
      userId: 'u-1',
      waiterId: null,
      operatorName: 'Markus Maier',
    });
    const other = setup();
    await other.service.signPayment('pay-1');
    expect([...other.rows.values()][0]).toMatchObject({
      userId: null,
      waiterId: null,
      operatorName: null,
    });
  });

  it('cuts the snapshot to 50 characters (DSFinV-K field length)', async () => {
    const { service, rows } = setup();
    await service.signZeroReceipt('order-1', {
      terminal: 'device-1',
      waiterId: 'w-1',
      operatorName: 'A'.repeat(80),
    });
    expect([...rows.values()][0]?.operatorName).toBe('A'.repeat(50));
  });
});

describe('TseSigningService — Gegenbelege, Pfand, Bestellungen', () => {
  it('signs a refund as negative Kassenbeleg referencing the original receipt', async () => {
    const { service, client, rows, txRepository } = setup();
    txRepository.findOne.mockResolvedValueOnce({ id: 'tx-original' } as never);
    const view = await service.signRefund({
      id: 'refund-1',
      organizationId: ORG,
      orderId: 'order-1',
      paymentId: 'pay-1',
      eventId: 'event-1',
      refundNumber: 'A-1-E1',
      kind: 'refund',
      amount: -5.9,
      pfandAmount: 0,
      tipAmount: 0,
      paymentMethod: 'cash',
      status: 'completed',
      isTest: false,
      deviceId: 'device-1',
      userId: null,
      items: [],
      taxLines: [],
      metadata: {
        composition: { goods: { '19': 450, '7': 140 }, pfand: 0, tip: 0 },
      },
    } as never);
    const [, , finishReq] = client.finishTransaction.mock
      .calls[0] as unknown as [unknown, number, { processData: string }];
    expect(finishReq.processData).toBe(
      'Beleg^-4.50_-1.40_0.00_0.00_0.00^-5.90:Bar',
    );
    expect(view?.kind).toBe('refund');
    expect([...rows.values()][0]).toMatchObject({
      kind: 'refund',
      refundId: 'refund-1',
      referencesTseTransactionId: 'tx-original',
      amount: '-5.90',
    });
  });

  it('signs a Pfand payout as negative cash in the 0 % slot', async () => {
    const { service, client } = setup();
    const view = await service.signPfandReturn({
      id: 'pr-1',
      organizationId: ORG,
      eventId: 'event-1',
      totalAmount: 4,
      lines: [],
      isTest: false,
      deviceId: 'device-1',
      createdByUserId: null,
    } as never);
    const [, , finishReq] = client.finishTransaction.mock
      .calls[0] as unknown as [unknown, number, { processData: string }];
    expect(finishReq.processData).toBe(
      'Beleg^0.00_0.00_0.00_0.00_-4.00^-4.00:Bar',
    );
    expect(view?.kind).toBe('deposit_return');
  });

  it('signs every unpaid order as Bestellung-V1 (table and counter „Senden“), never a paid one', async () => {
    const paid = setup({ order: { paymentStatus: 'paid' } });
    await expect(
      paid.service.signOrderCreated('order-1', { terminal: 'd' }),
    ).resolves.toBeNull();
    expect(paid.client.startTransaction).not.toHaveBeenCalled();

    // Theke im Kassiermodus „tab“: Kuechenbon vor der Zahlung → TSE-Spur.
    const counter = setup({
      order: { fulfillmentType: 'counter_pickup', paymentStatus: 'unpaid' },
    });
    const counterView = await counter.service.signOrderCreated('order-1', {
      terminal: 'd',
    });
    expect(counterView?.kind).toBe('order');
    expect(counterView?.processType).toBe('Bestellung-V1');

    const table = setup({
      order: { tableNumber: '12', fulfillmentType: 'table_service' },
    });
    const view = await table.service.signOrderCreated('order-1', {
      terminal: 'd',
    });
    const [, startReq] = table.client.startTransaction.mock
      .calls[0] as unknown as [unknown, { processType: string }];
    expect(startReq.processType).toBe('Bestellung-V1');
    const [, , finishReq] = table.client.finishTransaction.mock
      .calls[0] as unknown as [unknown, number, { processData: string }];
    expect(finishReq.processData).toBe('2;"Bier";4.50\r1;"Brezel";2.90');
    expect(view?.kind).toBe('order');
  });

  it('signs a cancellation of a signed order as Bestellung-V1 with negative quantities', async () => {
    const { service, client } = setup();
    const view = await service.signOrderChange(
      'order-1',
      [
        {
          item: {
            productName: 'Bier',
            unitPrice: 4.5,
            optionsPrice: 0,
          } as never,
          quantity: -1,
        },
      ],
      { terminal: 'd' },
    );
    const [, , finishReq] = client.finishTransaction.mock
      .calls[0] as unknown as [unknown, number, { processData: string }];
    expect(finishReq.processData).toBe('-1;"Bier";4.50');
    expect(view?.kind).toBe('order_cancellation');
  });

  it('signs a zero receipt for a fully discounted order', async () => {
    const { service, client } = setup();
    await service.signZeroReceipt('order-1', { terminal: 'd' });
    const [, , finishReq] = client.finishTransaction.mock
      .calls[0] as unknown as [unknown, number, { processData: string }];
    expect(finishReq.processData).toBe(
      'Beleg^0.00_0.00_0.00_0.00_0.00^0.00:Bar',
    );
  });
});
