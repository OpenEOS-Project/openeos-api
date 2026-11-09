import { pfandReturnPrintData } from '../print-jobs/order-print.service';
import { lineVatRate, pfandReturnTaxLines } from './pfand-return-receipt';

describe('Pfandrückgabe als Beleg', () => {
  const lines = [
    { unitAmount: 2, quantity: 3, vatRate: 19 },
    { unitAmount: 0.5, quantity: 2, vatRate: 7 },
  ];

  it('reduces VAT at the rate of the Pfand type (negative tax lines)', () => {
    expect(pfandReturnTaxLines(lines, false)).toEqual([
      // 6,00 * 19 / 119 = 0,96
      { rate: 19, gross: -6, tax: -0.96, net: -5.04 },
      // 1,00 * 7 / 107 = 0,07
      { rate: 7, gross: -1, tax: -0.07, net: -0.93 },
    ]);
  });

  it('shows no VAT for VAT-exempt organizations and 0 % types', () => {
    expect(pfandReturnTaxLines(lines, true)).toEqual([]);
    expect(pfandReturnTaxLines(lines, undefined)).toEqual([]);
    expect(
      pfandReturnTaxLines([{ unitAmount: 2, quantity: 1, vatRate: 0 }], false),
    ).toEqual([]);
  });

  it('treats returns from before 2026-11 (no rate) as not taxable', () => {
    expect(lineVatRate({})).toBe(0);
    expect(
      pfandReturnTaxLines([{ unitAmount: 2, quantity: 1 }], false),
    ).toEqual([]);
  });

  it('builds the print payload: negative lines, VAT, cash, number', () => {
    const createdAt = new Date('2026-11-09T18:00:00Z');
    const data = pfandReturnPrintData({
      id: 'pr-1',
      returnNumber: 'P-20261109-0007',
      createdAt,
      totalAmount: 7,
      lines: [
        {
          pfandTypeId: 'a',
          name: 'Becher',
          unitAmount: 2,
          quantity: 3,
          vatRate: 19,
        },
        {
          pfandTypeId: 'b',
          name: 'Teller',
          unitAmount: 0.5,
          quantity: 2,
          vatRate: 7,
        },
      ],
      taxLines: pfandReturnTaxLines(lines, false),
    });
    expect(data).toMatchObject({
      pfand_return_id: 'pr-1',
      return_number: 'P-20261109-0007',
      created_at: createdAt,
      items: [
        {
          quantity: 3,
          name: 'Becher',
          unit_amount: 2,
          total: -6,
          vat_rate: 19,
        },
        {
          quantity: 2,
          name: 'Teller',
          unit_amount: 0.5,
          total: -1,
          vat_rate: 7,
        },
      ],
      tax_amount: -1.03,
      total: -7,
      payment_method: 'cash',
      payment_label: 'Bar',
    });
  });
});
