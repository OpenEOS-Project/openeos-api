import { OrderItemStatus } from '../../database/entities/order-item.entity';
import { tipByRate } from '../refunds/refund-calc';
import {
  VAT_EXEMPT_NOTICE,
  buildReceiptTax,
  vatExemptNotice,
} from './receipt-tax.util';

/**
 * Trinkgeld und Kleinunternehmer auf dem Bon (Steuerberater 2026-11-10,
 * Fragen 3–5 und 9).
 */
describe('tipByRate (Trinkgeld je Satz nach Nettoentgelten)', () => {
  it('splits 1,00 € onto 19 %/7 % by net amounts, rounding rest on the largest share', () => {
    const shares = tipByRate(
      new Map([
        [19, 900],
        [7, 290],
      ]),
      100,
    );
    expect(Object.fromEntries(shares)).toEqual({ 19: 74, 7: 26 });
  });

  it('keeps the sign for refunds and sums up exactly', () => {
    const shares = tipByRate(
      new Map([
        [19, 333],
        [7, 333],
        [0, 334],
      ]),
      -101,
    );
    expect([...shares.values()].reduce((a, b) => a + b, 0)).toBe(-101);
    expect([...shares.values()].every((v) => v <= 0)).toBe(true);
  });

  it('single rate takes everything; no goods → fallback shares, else 19 %', () => {
    expect(Object.fromEntries(tipByRate(new Map([[7, 500]]), 50))).toEqual({
      7: 50,
    });
    expect(
      Object.fromEntries(tipByRate(new Map(), 50, new Map([[7, 1]]))),
    ).toEqual({ 7: 50 });
    expect(Object.fromEntries(tipByRate(new Map(), 50))).toEqual({ 19: 50 });
  });
});

describe('buildReceiptTax with tips', () => {
  const items = [
    { totalPrice: 9, taxRate: 19, status: OrderItemStatus.PENDING },
    { totalPrice: 2.9, taxRate: 7, status: OrderItemStatus.PENDING },
  ];

  it('club tip raises VAT at the goods rates', () => {
    const tax = buildReceiptTax(items as never, 0, false, {
      amount: 1,
      toClub: true,
    });
    expect(tax.tax_lines).toEqual([
      { rate: 19, gross: 9.74, tax: 1.56, net: 8.18 },
      { rate: 7, gross: 3.16, tax: 0.21, net: 2.95 },
    ]);
  });

  it('employee tip (TrinkgeldAN) does not', () => {
    const tax = buildReceiptTax(items as never, 0, false, {
      amount: 1,
      toClub: false,
    });
    expect(tax.tax_lines?.map((l) => l.gross)).toEqual([9, 2.9]);
  });

  it('Kleinunternehmer: no VAT lines, but the § 19 notice', () => {
    expect(
      buildReceiptTax(items as never, 0, undefined, {
        amount: 1,
        toClub: true,
      }),
    ).toEqual({});
    expect(vatExemptNotice(undefined)).toEqual({
      vat_exempt_notice: VAT_EXEMPT_NOTICE,
    });
    expect(vatExemptNotice(true).vat_exempt_notice).toContain('§ 19');
    expect(vatExemptNotice(false)).toEqual({});
  });
});
