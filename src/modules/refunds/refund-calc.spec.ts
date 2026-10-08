import { OrderItemStatus } from '../../database/entities/order-item.entity';
import type { OrderItem } from '../../database/entities/order-item.entity';
import {
  allocateRefund,
  amountComposition,
  compositionTotal,
  displayStatusOf,
  itemsRefund,
  orderComposition,
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
    expect(c.pfand).toBe(400);
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
    expect(composition.pfand).toBe(0);
    expect(compositionTotal(composition)).toBe(720);
  });

  it('a free amount reduces goods first, proportionally per rate', () => {
    const remaining = orderComposition(items, order);
    const c = amountComposition(remaining, 1000);
    expect(compositionTotal(c)).toBe(1000);
    expect(c.pfand).toBe(0);
    expect(c.tip).toBe(0);
    expect(c.goods.get(19)! + c.goods.get(7)!).toBe(1000);
    expect(c.goods.get(7)).toBe(50); // 180/3600 of 1000
  });

  it('a free amount beyond the goods takes deposit, then tip', () => {
    const remaining = orderComposition(items, order);
    const c = amountComposition(remaining, 3900);
    expect(c.pfand).toBe(300);
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
  });
});
