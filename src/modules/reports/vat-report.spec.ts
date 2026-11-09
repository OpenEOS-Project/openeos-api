import { buildVatReport } from './vat-report';

describe('buildVatReport (Umsatzsteuer je Satz)', () => {
  const sales = {
    // Cent: Ware 19 % 100,00 / 7 % 53,50; Pfand 19 % 20,00, Bestand 0 % 4,00
    goodsByRate: new Map([
      [19, 10000],
      [7, 5350],
    ]),
    depositsByRate: new Map([
      [19, 2000],
      [0, 400],
    ]),
  };

  it('shows goods, deposits and deposit returns per rate with contained VAT', () => {
    const report = buildVatReport({
      vatExempt: false,
      sales,
      goodwillRefunds: [
        // Kulanz: 10,00 Ware 19 % und 2,00 Pfand 19 %
        { goods: { '19': 1000 }, pfand: 200, pfandByRate: { '19': 200 } },
        // alte Erstattung ohne Satz fuer Pfand
        { goods: {}, pfand: 200 },
      ],
      pfandReturnLines: [
        { unitAmount: 2, quantity: 4, vatRate: 19 },
        { unitAmount: 2, quantity: 1 },
      ],
    });
    expect(report.rows).toEqual([
      {
        rate: 19,
        goods: 90,
        deposits: 18,
        depositReturns: -8,
        gross: 100,
        tax: 15.97,
        net: 84.03,
      },
      {
        rate: 7,
        goods: 53.5,
        deposits: 0,
        depositReturns: 0,
        gross: 53.5,
        tax: 3.5,
        net: 50,
      },
      {
        rate: 0,
        goods: 0,
        deposits: 2,
        depositReturns: -2,
        gross: 0,
        tax: 0,
        net: 0,
      },
    ]);
    expect(report.total).toEqual({
      goods: 143.5,
      deposits: 20,
      depositReturns: -10,
      gross: 153.5,
      tax: 19.47,
      net: 134.03,
    });
  });

  it('Kleinunternehmer: everything at 0 % without VAT', () => {
    const report = buildVatReport({
      vatExempt: true,
      sales,
      goodwillRefunds: [],
      pfandReturnLines: [{ unitAmount: 2, quantity: 1, vatRate: 19 }],
    });
    expect(report.vatExempt).toBe(true);
    expect(report.rows).toEqual([
      {
        rate: 0,
        goods: 153.5,
        deposits: 24,
        depositReturns: -2,
        gross: 175.5,
        tax: 0,
        net: 175.5,
      },
    ]);
  });
});
