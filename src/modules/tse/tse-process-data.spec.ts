import type { OrderItem } from '../../database/entities/order-item.entity';
import { OrderItemStatus } from '../../database/entities/order-item.entity';
import { orderComposition } from '../refunds/refund-calc';
import {
  abortProcessData,
  bestellungProcessData,
  clientIdForOrganization,
  formatCents,
  isoFromUnix,
  kassenbelegProcessData,
  normalizePayments,
  paymentTypeFor,
  qrCodePayload,
  slotsFromComposition,
  slotsTotal,
  vatSlot,
} from './tse-process-data';
import {
  fitSlots,
  paymentComposition,
  refundComposition,
} from './tse-signing.service';

function item(
  rate: number,
  unit: number,
  quantity: number,
  extra: Record<string, unknown> = {},
) {
  return {
    id: `item-${rate}-${unit}`,
    productName: `P ${rate}`,
    quantity,
    unitPrice: unit,
    optionsPrice: 0,
    totalPrice: Math.round(unit * quantity * 100) / 100,
    taxRate: rate,
    status: OrderItemStatus.PENDING,
    depositAmount: 0,
    ...extra,
  } as unknown as OrderItem;
}

describe('formatCents', () => {
  it.each([
    [0, '0.00'],
    [1, '0.01'],
    [119, '1.19'],
    [123456, '1234.56'],
    [-500, '-5.00'],
    [-1, '-0.01'],
  ])('%d -> %s', (cents, text) => {
    expect(formatCents(cents)).toBe(text);
  });
});

describe('vatSlot', () => {
  it('maps German rates to the five DSFinV-K slots', () => {
    expect(vatSlot(19, false)).toBe(0);
    expect(vatSlot(7, false)).toBe(1);
    expect(vatSlot(10.7, false)).toBe(2);
    expect(vatSlot(5.5, false)).toBe(3);
    expect(vatSlot(0, false)).toBe(4);
    expect(vatSlot('19.00' as never, false)).toBe(0);
  });

  it('books everything into the 0 % slot for VAT-exempt organizations', () => {
    expect(vatSlot(19, true)).toBe(4);
    expect(vatSlot(7, true)).toBe(4);
  });
});

describe('kassenbelegProcessData', () => {
  it('matches the DSFinV-K example format', () => {
    expect(
      kassenbelegProcessData('Beleg', {
        slots: [7533, 799, 0, 0, 0],
        payments: [
          { type: 'Unbar', cents: 6430 },
          { type: 'Bar', cents: 1000 },
          { type: 'Bar', cents: 500, currency: 'USD' },
          { type: 'Bar', cents: 500, currency: 'CHF' },
        ],
      }),
    ).toBe(
      'Beleg^75.33_7.99_0.00_0.00_0.00^10.00:Bar_5.00:Bar:USD_5.00:Bar:CHF_64.30:Unbar',
    );
  });

  it('sums several payments of the same type and drops zero amounts', () => {
    expect(
      normalizePayments([
        { type: 'Unbar', cents: 300 },
        { type: 'Bar', cents: 0 },
        { type: 'Unbar', cents: 200 },
      ]),
    ).toEqual([{ type: 'Unbar', cents: 500, currency: 'EUR' }]);
  });

  it('writes 0.00 bar for a zero receipt', () => {
    expect(
      kassenbelegProcessData('Beleg', { slots: [0, 0, 0, 0, 0], payments: [] }),
    ).toBe('Beleg^0.00_0.00_0.00_0.00_0.00^0.00:Bar');
  });

  it('marks training bookings as AVTraining', () => {
    expect(
      kassenbelegProcessData('AVTraining', {
        slots: [119, 0, 0, 0, 0],
        payments: [{ type: 'Bar', cents: 119 }],
      }),
    ).toBe('AVTraining^1.19_0.00_0.00_0.00_0.00^1.19:Bar');
  });

  it('writes negative refunds with a leading minus', () => {
    expect(
      kassenbelegProcessData('Beleg', {
        slots: [-500, -250, 0, 0, -200],
        payments: [{ type: 'Unbar', cents: -950 }],
      }),
    ).toBe('Beleg^-5.00_-2.50_0.00_0.00_-2.00^-9.50:Unbar');
  });

  it('closes dangling transactions with an empty AVBelegabbruch', () => {
    expect(abortProcessData()).toBe('AVBelegabbruch^0.00_0.00_0.00_0.00_0.00^');
  });

  it('maps only cash to Bar', () => {
    expect(paymentTypeFor('cash')).toBe('Bar');
    for (const method of [
      'card',
      'sumup_terminal',
      'sumup_online',
      'paypal',
      'apple_pay',
      undefined,
    ]) {
      expect(paymentTypeFor(method)).toBe('Unbar');
    }
  });
});

describe('amounts per rate (rounding, several rates)', () => {
  it('splits an order with 19 % and 7 % items and a discount exactly', () => {
    const items = [item(19, 3.5, 3), item(7, 2.2, 1)];
    // Zwischensumme 12,70 – Rabatt 1,00 = 11,70
    const order = { items, discountAmount: 1, tipAmount: 0, total: 11.7 };
    const composition = orderComposition(items, order);
    const slots = slotsFromComposition(composition, false);
    expect(slotsTotal(slots)).toBe(1170);
    expect(slots[0]).toBeGreaterThan(0);
    expect(slots[1]).toBeGreaterThan(0);
    expect(slots[2] + slots[3] + slots[4]).toBe(0);
  });

  it('puts Pfand and tip into the 0 % slot like the paper receipt', () => {
    const items = [item(19, 4, 2, { depositAmount: 2 })];
    // 8,00 Ware + 4,00 Pfand + 1,00 Trinkgeld
    const order = { items, discountAmount: 0, tipAmount: 1, total: 13 };
    const slots = slotsFromComposition(orderComposition(items, order), false);
    expect(slots).toEqual([800, 0, 0, 0, 500]);
  });

  it('scales the order to a partial payment and keeps the sum exact', () => {
    const items = [item(19, 3.33, 1), item(7, 3.33, 1), item(19, 3.34, 1)];
    const order = { items, discountAmount: 0, tipAmount: 0, total: 10 };
    const composition = paymentComposition(
      order as never,
      {
        amount: 3.33,
        metadata: {},
        itemPayments: [],
      } as never,
    );
    const slots = fitSlots(slotsFromComposition(composition, false), 333);
    expect(slotsTotal(slots)).toBe(333);
  });

  it('uses the paid items of a device split payment', () => {
    const items = [
      { ...item(19, 5, 2), id: 'a' },
      { ...item(7, 3, 1), id: 'b' },
    ];
    const order = { items, discountAmount: 0, tipAmount: 0, total: 13 };
    const composition = paymentComposition(
      order as never,
      {
        amount: 8,
        metadata: {
          splitItems: [
            { orderItemId: 'a', quantity: 1 },
            { orderItemId: 'b', quantity: 1 },
          ],
        },
        itemPayments: [],
      } as never,
    );
    expect(slotsFromComposition(composition, false)).toEqual([
      500, 300, 0, 0, 0,
    ]);
  });

  it('uses the assigned amounts of an admin split payment', () => {
    const composition = paymentComposition(
      { items: [], discountAmount: 0, tipAmount: 0, total: 9 } as never,
      {
        amount: 6,
        metadata: {},
        itemPayments: [
          { amount: 4, orderItem: { taxRate: 19 } },
          { amount: 2, orderItem: { taxRate: 7 } },
        ],
      } as never,
    );
    expect(slotsFromComposition(composition, false)).toEqual([
      400, 200, 0, 0, 0,
    ]);
  });

  it('builds negative slots for a refund from its stored composition', () => {
    const composition = refundComposition({
      metadata: {
        composition: { goods: { '19': 500, '7': 250 }, pfand: 200, tip: 0 },
      },
      taxLines: [],
      amount: -9.5,
      pfandAmount: -2,
      tipAmount: 0,
      items: [],
    } as never);
    expect(slotsFromComposition(composition, false, -1)).toEqual([
      -500, -250, 0, 0, -200,
    ]);
  });

  it('fitSlots moves rounding differences into the biggest slot', () => {
    expect(fitSlots([333, 333, 0, 0, 333], 1000)).toEqual([
      334, 333, 0, 0, 333,
    ]);
    expect(fitSlots([0, 0, 0, 0, 0], 250)).toEqual([0, 0, 0, 0, 250]);
    expect(fitSlots([-499, 0, 0, 0, 0], -500)).toEqual([-500, 0, 0, 0, 0]);
  });
});

describe('Bestellung-V1', () => {
  it('writes one line per position, CR separated, quoted names', () => {
    expect(
      bestellungProcessData([
        { quantity: 2, name: 'Weizen 0,5l', unitCents: 450 },
        { quantity: 1, name: 'Wurst "scharf"', unitCents: 380 },
      ]),
    ).toBe('2;"Weizen 0,5l";4.50\r1;"Wurst ""scharf""";3.80');
  });

  it('writes cancellations with negative quantities and skips zero lines', () => {
    expect(
      bestellungProcessData([
        { quantity: -1, name: 'Pommes', unitCents: 350 },
        { quantity: 0, name: 'Nichts', unitCents: 100 },
      ]),
    ).toBe('-1;"Pommes";3.50');
  });
});

describe('QR code (DSFinV-K Anhang I, V0)', () => {
  it('joins the twelve fields with semicolons in the documented order', () => {
    const qr = qrCodePayload({
      clientId: '955002-00',
      processType: 'Kassenbeleg-V1',
      processData: 'Beleg^0.00_2.55_0.00_0.00_0.00^2.55:Bar',
      transactionNumber: 18,
      signatureCounter: 112,
      startTime: '2019-07-10T18:41:04.000Z',
      finishTime: '2019-07-10T18:41:04.000Z',
      signatureAlgorithm: 'ecdsa-plain-SHA256',
      logTimeFormat: 'unixTime',
      signatureValue:
        'MEQCIAy4P9k+7x9saDO0uRZ4El8QwN+qTgYiv1DIaJIMWRiuAiAt+saFDGjK2Yi5Cxgy7PprXQ5O0seRgx4ltdpW9REvwA==',
      publicKey:
        'BHhWOeisRpPBTGQ1W4VUH95TXx2GARf8e2NYZXJoInjtGqnxJ8sZ3CQpYgjI+LYEmW5A37sLWHsyU7nSJUBemyU=',
    });
    expect(qr).toBe(
      'V0;955002-00;Kassenbeleg-V1;Beleg^0.00_2.55_0.00_0.00_0.00^2.55:Bar;18;112;2019-07-10T18:41:04.000Z;2019-07-10T18:41:04.000Z;ecdsa-plain-SHA256;unixTime;MEQCIAy4P9k+7x9saDO0uRZ4El8QwN+qTgYiv1DIaJIMWRiuAiAt+saFDGjK2Yi5Cxgy7PprXQ5O0seRgx4ltdpW9REvwA==;BHhWOeisRpPBTGQ1W4VUH95TXx2GARf8e2NYZXJoInjtGqnxJ8sZ3CQpYgjI+LYEmW5A37sLWHsyU7nSJUBemyU=',
    );
    expect(qr.split(';')).toHaveLength(12);
  });

  it('converts TSE unix seconds to ISO 8601 UTC with milliseconds', () => {
    expect(isoFromUnix(1562784064)).toBe('2019-07-10T18:41:04.000Z');
  });
});

describe('clientIdForOrganization', () => {
  it('is OEOS- plus 12 hex characters (max. 30, TR-03153 charset)', () => {
    const id = clientIdForOrganization('7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a99');
    expect(id).toBe('OEOS-7D0C7A524F43');
    expect(id.length).toBeLessThanOrEqual(30);
    expect(id).toMatch(/^[A-Za-z0-9-]+$/);
  });
});
