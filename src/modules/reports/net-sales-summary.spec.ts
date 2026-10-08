import { netSalesSummary } from './reports.service';

/*
 * Abgleich Produkte ↔ Umsatz netto. Fixture wie im Postgres-Test
 * (refunds.db.spec.ts): Verkauf, Teilerstattung nach Position, Storno mit
 * Erstattung, Kulanz ohne Position, Rabatt + Trinkgeld, unbezahltes Storno.
 */
describe('netSalesSummary', () => {
  it('splits goodwill refunds into item refunds and refunds without a position', () => {
    const summary = netSalesSummary({
      netRevenue: 188.2,
      tips: 2,
      // Kulanz-Ware: 10 (B, Burger) + 5 (D, Betrag) + 9 (E, Burger nach Rabatt)
      goodwillGoods: -24,
      itemsRevenue: 191.2,
      // davon ueber erstattete Mengen bei den Produkten abgezogen: 10 + 9
      attributedRefunds: 19,
    });

    expect(summary).toEqual({
      itemsRevenue: 191.2,
      unassignedRefunds: -5,
      tips: 2,
      netRevenue: 188.2,
    });
    expect(
      Math.round(
        (summary.itemsRevenue + summary.unassignedRefunds + summary.tips) * 100,
      ) / 100,
    ).toBe(summary.netRevenue);
  });

  it('a full refund after a free amount does not count the amount twice', () => {
    // 38 Ware: erst 5 € Kulanz (Betrag), dann „alles“ (33 € Ware) — alle
    // Mengen erstattet, die Produkte stehen bei 0 und decken die 38 ab.
    const summary = netSalesSummary({
      netRevenue: 0,
      tips: 0,
      goodwillGoods: -38,
      itemsRevenue: 0,
      attributedRefunds: 38,
    });
    expect(summary.unassignedRefunds).toBe(0);
    expect(summary.itemsRevenue + summary.unassignedRefunds).toBe(0);
  });

  it('rounds to cents', () => {
    expect(
      netSalesSummary({
        netRevenue: 10.004,
        tips: 0.333333,
        goodwillGoods: -1.0049,
        itemsRevenue: 9.666666,
        attributedRefunds: 0,
      }),
    ).toEqual({
      itemsRevenue: 9.67,
      unassignedRefunds: -1,
      tips: 0.33,
      netRevenue: 10,
    });
  });
});
