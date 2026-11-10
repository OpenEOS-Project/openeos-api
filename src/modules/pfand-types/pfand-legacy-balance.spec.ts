import { depositReturnSlots } from '../tse/tse-process-data';
import { allocateLegacyBalance, legacyCentsOf } from './pfand-legacy-balance';
import { pfandReturnTaxLines } from './pfand-return-receipt';

/** Pfand-Altsaldo (Steuerberater 2026-11-10, Frage 2), rein. */
describe('Pfand-Altsaldo', () => {
  const lines = [
    {
      pfandTypeId: 'b',
      name: 'Becher',
      unitAmount: 2,
      quantity: 3,
      vatRate: 19,
    },
    {
      pfandTypeId: 't',
      name: 'Teller',
      unitAmount: 0.5,
      quantity: 2,
      vatRate: 7,
    },
  ];

  it('allocates the open balance line by line until it is used up', () => {
    expect(allocateLegacyBalance(lines, 700).map((l) => l.legacyCents)).toEqual(
      [600, 100],
    );
    expect(allocateLegacyBalance(lines, 250).map((l) => l.legacyCents)).toEqual(
      [250, undefined],
    );
    expect(allocateLegacyBalance(lines, 0).map((l) => l.legacyCents)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('legacy share never reduces VAT: receipt tax lines and TSE slots', () => {
    const allocated = allocateLegacyBalance(lines, 250);
    expect(pfandReturnTaxLines(allocated, false)).toEqual([
      { rate: 19, gross: -3.5, tax: -0.56, net: -2.94 },
      { rate: 7, gross: -1, tax: -0.07, net: -0.93 },
    ]);
    expect(depositReturnSlots(allocated, false)).toEqual([
      -350, -100, 0, 0, -250,
    ]);
  });

  it('returns without rate (before the switch) count fully as legacy', () => {
    expect(
      legacyCentsOf({ unitAmount: 2, quantity: 2, vatRate: undefined }),
    ).toBe(400);
    expect(
      legacyCentsOf({
        unitAmount: 2,
        quantity: 2,
        vatRate: 19,
        legacyCents: 900,
      }),
    ).toBe(400);
  });
});
