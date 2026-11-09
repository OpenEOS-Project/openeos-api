import { OrderItemStatus } from '../../database/entities/order-item.entity';
import type { OrderItem } from '../../database/entities/order-item.entity';
import {
  allocateRefund,
  amountComposition,
  compositionTotal,
  displayStatusOf,
  itemsRefund,
  orderComposition,
  pfandSum,
  refundTaxLines,
  scaleComposition,
  subtractComposition,
} from './refund-calc';

function item(
  over: Partial<OrderItem> & { totalPrice: number; quantity: number },
): OrderItem {
  return {
    id: over.id ?? Math.random().toString(36),
    unitPrice: over.totalPrice / over.quantity,
    optionsPrice: 0,
    taxRate: 19,
    status: OrderItemStatus.PENDING,
    depositAmount: 0,
    refundedQuantity: 0,
    ...over,
  } as OrderItem;
}

describe('refund-calc', () => {
  const burger = item({ id: 'b', quantity: 3, totalPrice: 30, taxRate: 19 });
  const pils = item({
    id: 'p',
    quantity: 2,
    totalPrice: 8,
    taxRate: 19,
    depositAmount: 2,
  });
  const water = item({ id: 'w', quantity: 1, totalPrice: 2, taxRate: 7 });
  const items = [burger, pils, water];
  // 40 Ware - 4 Rabatt + 4 Pfand + 1 Trinkgeld = 41
  const order = { discountAmount: 4, tipAmount: 1, total: 41 };

  it('splits an order into goods per rate, deposit and tip (exact total)', () => {
    const c = orderComposition(items, order);
    expect(pfandSum(c)).toBe(400);
    // Bestand ohne Satz: Pfand nicht steuerbar (0 %), wie vor 2026-11.
    expect([...c.pfand.entries()]).toEqual([[0, 400]]);
    expect(c.tip).toBe(100);
    expect(c.goods.get(19)).toBe(3420); // 38 * 0.9
    expect(c.goods.get(7)).toBe(180); // 2 * 0.9
    expect(compositionTotal(c)).toBe(4100);
  });

  it('ignores cancelled items', () => {
    const c = orderComposition(
      [
        ...items,
        item({
          quantity: 1,
          totalPrice: 99,
          status: OrderItemStatus.CANCELLED,
        }),
      ],
      order,
    );
    expect(compositionTotal(c)).toBe(4100);
  });

  it('refunds items with their share of the discount plus deposit', () => {
    const { lines, composition } = itemsRefund(
      items,
      [{ item: pils, quantity: 1 }],
      order.discountAmount,
      true,
    );
    expect(lines[0].goods).toBe(360); // 4.00 * 0.9
    expect(lines[0].deposit).toBe(200);
    expect(compositionTotal(composition)).toBe(560);
  });

  it('can leave the deposit out', () => {
    const { composition } = itemsRefund(
      items,
      [{ item: pils, quantity: 2 }],
      order.discountAmount,
      false,
    );
    expect(pfandSum(composition)).toBe(0);
    expect(compositionTotal(composition)).toBe(720);
  });

  it('a free amount reduces goods first, proportionally per rate', () => {
    const remaining = orderComposition(items, order);
    const c = amountComposition(remaining, 1000);
    expect(compositionTotal(c)).toBe(1000);
    expect(pfandSum(c)).toBe(0);
    expect(c.tip).toBe(0);
    expect(c.goods.get(19)! + c.goods.get(7)!).toBe(1000);
    expect(c.goods.get(7)).toBe(50); // 180/3600 of 1000
  });

  it('a free amount beyond the goods takes deposit, then tip', () => {
    const remaining = orderComposition(items, order);
    const c = amountComposition(remaining, 3900);
    expect(pfandSum(c)).toBe(300);
    expect(c.tip).toBe(0);
    expect(compositionTotal(c)).toBe(3900);
  });

  it('scales a composition exactly (rounding goes to the last part)', () => {
    const c = scaleComposition(orderComposition(items, order), 1001);
    expect(compositionTotal(c)).toBe(1001);
  });

  it('subtracts compositions per rate', () => {
    const a = orderComposition(items, order);
    const diff = subtractComposition(a, a);
    expect(compositionTotal(diff)).toBe(0);
  });

  it('tax lines are negative and only for taxable orgs', () => {
    const c = orderComposition(items, order);
    expect(refundTaxLines(c, undefined)).toEqual([]);
    expect(refundTaxLines(c, true)).toEqual([]);
    const lines = refundTaxLines(c, false);
    expect(lines).toEqual([
      { rate: 19, gross: -34.2, tax: -5.46, net: -28.74 },
      { rate: 7, gross: -1.8, tax: -0.12, net: -1.68 },
    ]);
  });

  describe('allocateRefund', () => {
    const payments = [
      {
        id: 'old',
        refundable: 1000,
        isProvider: false,
        createdAt: new Date(1),
      },
      { id: 'new', refundable: 500, isProvider: true, createdAt: new Date(2) },
    ];
    it('takes the newest payment first', () => {
      expect(allocateRefund(payments, 700)).toEqual([
        { paymentId: 'new', amount: 500 },
        { paymentId: 'old', amount: 200 },
      ]);
    });
    it('respects a chosen payment', () => {
      expect(allocateRefund(payments, 700, 'old')).toEqual([
        { paymentId: 'old', amount: 700 },
      ]);
      expect(allocateRefund(payments, 700, 'new')).toBeNull();
    });
    it('fails when the payments do not cover the amount', () => {
      expect(allocateRefund(payments, 1600)).toBeNull();
    });
  });

  describe('displayStatusOf', () => {
    const base = {
      status: 'in_progress',
      paymentStatus: 'paid',
      total: 10,
      paidAmount: 10,
      refundedAmount: 0,
    };
    it.each([
      [{}, 'in_kitchen'],
      [{ status: 'ready' }, 'ready'],
      [{ status: 'completed' }, 'completed'],
      [{ paymentStatus: 'unpaid', paidAmount: 0 }, 'unpaid'],
      [{ paymentStatus: 'partly_paid', paidAmount: 4 }, 'unpaid'],
      [{ status: 'cancelled' }, 'cancelled'],
      [{ status: 'completed', refundedAmount: 3 }, 'partly_refunded'],
      [{ status: 'completed', refundedAmount: 10 }, 'refunded'],
      [{ status: 'cancelled', refundedAmount: 10 }, 'cancelled'],
      [{ paymentStatus: 'unpaid', total: 0, paidAmount: 0 }, 'in_kitchen'],
    ])('%j -> %s', (over, expected) => {
      expect(displayStatusOf({ ...base, ...over })).toBe(expected);
    });

    it.each([
      [{ paymentStatus: 'unpaid', paidAmount: 0 }, 'in_kitchen'],
      [{ paymentStatus: 'unpaid', paidAmount: 0, status: 'ready' }, 'ready'],
      [
        { paymentStatus: 'unpaid', paidAmount: 0, status: 'completed' },
        'completed',
      ],
      [{ paymentStatus: 'unpaid', status: 'cancelled' }, 'cancelled'],
    ])('order-only mode (no „unpaid“): %j -> %s', (over, expected) => {
      expect(displayStatusOf({ ...base, ...over }, { orderOnly: true })).toBe(
        expected,
      );
    });
  });
});

describe('refund-calc: Pfand mit Steuersatz (ab 2026-11)', () => {
  const beer = item({
    id: 'beer',
    quantity: 2,
    totalPrice: 8,
    taxRate: 19,
    depositAmount: 2,
    depositTaxRate: 19,
  });
  const soup = item({
    id: 'soup',
    quantity: 1,
    totalPrice: 5,
    taxRate: 7,
    depositAmount: 1,
    depositTaxRate: 7,
  });
  // 13 Ware + 4 Pfand (19 %) + 1 Pfand (7 %) = 18
  const order = { discountAmount: 0, tipAmount: 0, total: 18 };

  it('keeps the deposit per VAT rate', () => {
    const c = orderComposition([beer, soup], order);
    expect(c.pfand.get(19)).toBe(400);
    expect(c.pfand.get(7)).toBe(100);
    expect(compositionTotal(c)).toBe(1800);
  });

  it('tax lines include the deposit at its rate', () => {
    const c = orderComposition([beer, soup], order);
    expect(refundTaxLines(c, false)).toEqual([
      // 8 + 4 = 12 brutto, 12 * 19 / 119 = 1.92
      { rate: 19, gross: -12, tax: -1.92, net: -10.08 },
      // 5 + 1 = 6 brutto, 6 * 7 / 107 = 0.39
      { rate: 7, gross: -6, tax: -0.39, net: -5.61 },
    ]);
    // Kleinunternehmer: keine MwSt.
    expect(refundTaxLines(c, true)).toEqual([]);
  });

  it('a discount reduces goods only, the deposit stays whole', () => {
    const c = orderComposition([beer, soup], {
      discountAmount: 1.3,
      tipAmount: 0,
      total: 16.7,
    });
    expect(pfandSum(c)).toBe(500);
    expect(c.goods.get(19)! + c.goods.get(7)!).toBe(1170);
  });

  it('a free amount beyond the goods takes the deposit proportionally per rate', () => {
    const c = amountComposition(orderComposition([beer, soup], order), 1800);
    expect(c.pfand.get(19)).toBe(400);
    expect(c.pfand.get(7)).toBe(100);
  });

  it('item refunds carry the deposit at the rate of the item', () => {
    const { composition } = itemsRefund(
      [beer, soup],
      [{ item: beer, quantity: 1 }],
      0,
      true,
    );
    expect([...composition.pfand.entries()]).toEqual([[19, 200]]);
  });
});
