import { NotFoundException } from '@nestjs/common';

import type { Device } from '../../database/entities/device.entity';
import type { TseTransaction } from '../../database/entities/tse-transaction.entity';
import { tseReceiptView } from '../tse/tse-view';
import { DeviceApiController } from './device-api.controller';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

const ORG_ID = '05e0c31e-9b3a-4f43-9f8e-0f2b8f3f1a11';
const ORDER_ID = '3f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const device = { id: 'device-1', organizationId: ORG_ID } as Device;

type Ctor = new (...args: unknown[]) => DeviceApiController;

/** Konstruktor-Reihenfolge wie in device-api.controller.ts. */
function controller(options: {
  order?: { id: string } | null;
  forOrder?: jest.Mock;
  templates?: Array<{ type: string; template: unknown }>;
}) {
  const args: unknown[] = new Array(28).fill(undefined);
  const orderFindOne = jest.fn(() => Promise.resolve(options.order ?? null));
  args[4] = { findOne: orderFindOne };
  args[7] = { find: jest.fn(() => Promise.resolve(options.templates ?? [])) };
  args[26] = options.forOrder ? { forOrder: options.forOrder } : undefined;
  return {
    controller: new (DeviceApiController as unknown as Ctor)(...args),
    orderFindOne,
  };
}

function tx(over: Partial<TseTransaction>): TseTransaction {
  return {
    id: 'tx-1',
    kind: 'receipt',
    status: 'signed',
    training: false,
    processType: 'Kassenbeleg-V1',
    processData: 'Beleg^0.00_0.00_0.00_0.00_5.00^5.00:Bar',
    clientId: 'OEOS-05E0C31E9B3A',
    serialNumber: 'ab'.repeat(32),
    transactionNumber: '7',
    signatureCounter: '21',
    startTime: new Date('2026-11-03T15:06:36.000Z'),
    finishTime: new Date('2026-11-03T15:06:36.000Z'),
    signatureValue: 'c2ln',
    errorCode: null,
    terminal: 'device-1',
    orderId: ORDER_ID,
    paymentId: 'pay-1',
    refundId: null,
    pfandReturnId: null,
    createdAt: new Date('2026-11-03T15:06:36.000Z'),
    ...over,
  } as unknown as TseTransaction;
}

describe('GET /device-api/orders/:orderId/tse', () => {
  const unitInfo = {
    serialNumber: 'ab'.repeat(32),
    publicKey: 'cGs=',
    signatureAlgorithm: 'ecdsa-plain-SHA256',
    logTimeFormat: 'unixTime',
  };

  it('returns every TSE record of the order with QR payload and references', async () => {
    const views = [
      tseReceiptView(tx({}), unitInfo),
      tseReceiptView(
        tx({
          id: 'tx-2',
          kind: 'refund',
          paymentId: 'pay-1',
          refundId: 'refund-1',
          processData: 'Beleg^0.00_0.00_0.00_0.00_-5.00^-5.00:Bar',
        }),
        unitInfo,
      ),
    ];
    const forOrder = jest.fn(() => Promise.resolve(views));
    const { controller: c, orderFindOne } = controller({
      order: { id: ORDER_ID },
      forOrder,
    });

    const { data } = await c.getOrderTse(device, ORDER_ID);

    expect(orderFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ORDER_ID, organizationId: ORG_ID },
      }),
    );
    expect(forOrder).toHaveBeenCalledWith(ORDER_ID, ORG_ID);
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({
      kind: 'receipt',
      paymentId: 'pay-1',
      refundId: null,
      orderId: ORDER_ID,
    });
    expect(data[0].qrCode).toMatch(/^V0;OEOS-05E0C31E9B3A;Kassenbeleg-V1;/);
    expect(data[1]).toMatchObject({ kind: 'refund', refundId: 'refund-1' });
  });

  it('404s for orders of another organization', async () => {
    const forOrder = jest.fn();
    const { controller: c } = controller({ order: null, forOrder });
    await expect(c.getOrderTse(device, ORDER_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(forOrder).not.toHaveBeenCalled();
  });

  it('is empty without the TSE module', async () => {
    const { controller: c } = controller({ order: { id: ORDER_ID } });
    await expect(c.getOrderTse(device, ORDER_ID)).resolves.toEqual({
      data: [],
    });
  });
});

describe('GET /device-api/templates', () => {
  it('prints the payment label in custom templates', async () => {
    const { controller: c } = controller({
      templates: [
        {
          type: 'receipt',
          template: {
            generatedTemplate:
              'Zahlungsart: {{ payment_method }}\n<<FEED:3>>\n<<CUT>>',
          },
        },
      ],
    });
    const { data } = await c.getTemplates(device);
    expect(data.templates.receipt).toContain(
      'Zahlungsart: {{ payment_label|default(payment_method) }}',
    );
    // Der TSE-Block haengt weiter dran.
    expect(data.templates.receipt).toContain('tse.client_id');
  });
});
