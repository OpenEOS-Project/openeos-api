import type { PfandReturnLine } from '../../database/entities/pfand-return.entity';
import { legacyCentsOf } from '../pfand-types/pfand-legacy-balance';
import { mapSum, pfandFromRecord, rateMapFrom } from '../refunds/refund-calc';

/**
 * Umsatz und Umsatzsteuer je Steuersatz (Bericht „Umsatzsteuer“).
 *
 * Pfand gehoert zum Entgelt (Abschn. 10.1 Abs. 8 UStAE) und steht deshalb
 * beim Satz seiner Pfandart; eine Pfand-Rueckgabe mindert das Entgelt zum
 * selben Satz (§ 17 UStG). Beides wird je Satz getrennt ausgewiesen, damit
 * nachvollziehbar bleibt, was Ware und was Pfand ist:
 *
 *   Ware + Pfand − Pfand-Rueckgaben = Brutto je Satz → enthaltene USt
 *
 * Buchungen von vor der Umstellung (2026-11) haben fuer Pfand keinen Satz
 * gespeichert; sie stehen — wie damals auf Bon, TSE und im Bericht — bei
 * 0 % (nicht steuerbar).
 *
 * Trinkgeld an den Verein (TrinkgeldAG) ist Entgelt und steht anteilig
 * beim Satz der Ware seiner Bestellung (Steuerberater 2026-11-10, Frage 3);
 * Trinkgeld angestellter Bedienungen (TrinkgeldAN) ist kein Entgelt und
 * steht nur nachrichtlich in `employeeTips`.
 * Steuerbefreite Organisationen (Kleinunternehmer, `vatExempt !== false`)
 * weisen keine Umsatzsteuer aus: alle Betraege stehen dann bei 0 % ohne
 * Steuer.
 */
export interface VatReportRow {
  /** Steuersatz in Prozent (0 = nicht steuerbar / steuerbefreit). */
  rate: number;
  /** Warenwert brutto (nach Rabatt, Erstattungen ab). */
  goods: number;
  /** Pfand brutto aus Verkaeufen (Erstattungen ab). */
  deposits: number;
  /** Pfand-Rueckgaben (negativ). */
  depositReturns: number;
  /** Trinkgeld an den Verein (TrinkgeldAG), anteilig je Satz. */
  tips: number;
  /**
   * Einzweck-Wertmarken (§ 3 Abs. 14 UStG): Steuer beim Verkauf, nicht bei
   * der Einloesung — verkauft − eingeloest (+ bei Storno zurueckgegeben) −
   * zurueckgetauscht. Die eingeloeste Ware steht schon in `goods`.
   */
  singlePurposeTokens: number;
  /** Summe brutto = goods + deposits + depositReturns + tips + singlePurposeTokens. */
  gross: number;
  /** Enthaltene Umsatzsteuer. */
  tax: number;
  /** Netto = gross − tax. */
  net: number;
}

export interface VatReport {
  /** Organisation weist keine Umsatzsteuer aus (Kleinunternehmer). */
  vatExempt: boolean;
  rows: VatReportRow[];
  total: Omit<VatReportRow, 'rate'>;
  /** Trinkgeld angestellter Bedienungen (TrinkgeldAN, kein Entgelt), nachrichtlich. */
  employeeTips: number;
  /**
   * Mehrzweck-Wertmarken (§ 3 Abs. 15 UStG), nachrichtlich: Verkauf und
   * Ruecktausch sind nicht steuerbar (die Steuer steht mit der Ware in
   * `goods`, sobald sie eingeloest werden).
   */
  multiPurposeTokens: { sold: number; boughtBack: number };
}

/** Warenwert und Pfand je Satz in Cent (Verkauf, positiv). */
export interface VatSalesInput {
  goodsByRate: Map<number, number>;
  depositsByRate: Map<number, number>;
}

/** Gespeicherte Zusammensetzung einer Kulanz-Erstattung (`metadata.composition`). */
export type RefundCompositionRecord = {
  goods?: Record<string, unknown>;
  pfand?: unknown;
  pfandByRate?: unknown;
} | null;

const euros = (cents: number) => Math.round(cents) / 100;

function add(map: Map<number, number>, rate: number, value: number): void {
  if (!value) return;
  const key = Math.round(Number(rate) * 100) / 100;
  map.set(key, (map.get(key) ?? 0) + value);
}

/** Enthaltene Steuer eines Bruttobetrags (Cent), wie auf dem Bon. */
function taxOf(grossCents: number, rate: number): number {
  if (!rate) return 0;
  const sign = grossCents < 0 ? -1 : 1;
  return sign * Math.round((Math.abs(grossCents) * rate) / (100 + rate));
}

export function buildVatReport(input: {
  vatExempt: boolean;
  sales: VatSalesInput;
  /** Kulanz-Erstattungen (Zusammensetzung positiv gespeichert). */
  goodwillRefunds: RefundCompositionRecord[];
  /** Positionen der Pfand-Auszahlungen. */
  pfandReturnLines: Pick<
    PfandReturnLine,
    'unitAmount' | 'quantity' | 'vatRate' | 'legacyCents'
  >[];
  /** Trinkgeld: an den Verein je Satz (Cent), an Arbeitnehmer gesamt (Cent). */
  tips?: { clubByRate: Map<number, number>; employeeCents: number };
  /**
   * Wertmarken (Cent): Einzweck je Satz als Saldo (verkauft − eingeloest +
   * zurueckgegeben − zurueckgetauscht), Mehrzweck nachrichtlich.
   */
  tokens?: {
    singlePurposeByRate: Map<number, number>;
    multiPurposeSoldCents: number;
    multiPurposeBoughtBackCents: number;
  };
}): VatReport {
  const goods = new Map<number, number>();
  const deposits = new Map<number, number>();
  const returns = new Map<number, number>();
  const tips = new Map<number, number>();
  for (const [rate, value] of input.tips?.clubByRate ?? [])
    add(tips, rate, value);
  const vouchers = new Map<number, number>();
  for (const [rate, value] of input.tokens?.singlePurposeByRate ?? [])
    add(vouchers, rate, value);
  for (const [rate, value] of input.sales.goodsByRate) add(goods, rate, value);
  for (const [rate, value] of input.sales.depositsByRate)
    add(deposits, rate, value);
  for (const record of input.goodwillRefunds) {
    if (!record) continue;
    for (const [rate, value] of rateMapFrom(record.goods, true))
      add(goods, rate, -value);
    for (const [rate, value] of pfandFromRecord(record, true))
      add(deposits, rate, -value);
  }
  for (const line of input.pfandReturnLines) {
    const cents = Math.abs(
      Math.round(Number(line.unitAmount) * 100) * Number(line.quantity),
    );
    // Anteil gegen den Pfand-Altsaldo (bzw. Bestand ohne Satz) bei 0 %:
    // mindert keine Steuer (Steuerberater 2026-11-10, Frage 2).
    const legacy = legacyCentsOf(line);
    add(returns, 0, -legacy);
    add(returns, Number(line.vatRate ?? 0) || 0, -(cents - legacy));
  }

  // Steuerbefreit: alles bei 0 %, keine Steuer.
  const collapse = (map: Map<number, number>) =>
    input.vatExempt ? new Map([[0, mapSum(map)]]) : map;
  const g = collapse(goods);
  const d = collapse(deposits);
  const r = collapse(returns);
  const t = collapse(tips);
  const v = collapse(vouchers);

  const rates = [
    ...new Set([
      ...g.keys(),
      ...d.keys(),
      ...r.keys(),
      ...t.keys(),
      ...v.keys(),
    ]),
  ].sort((a, b) => b - a);
  const rows: VatReportRow[] = [];
  for (const rate of rates) {
    const goodsCents = g.get(rate) ?? 0;
    const depositCents = d.get(rate) ?? 0;
    const returnCents = r.get(rate) ?? 0;
    const tipCents = t.get(rate) ?? 0;
    const voucherCents = v.get(rate) ?? 0;
    const grossCents =
      goodsCents + depositCents + returnCents + tipCents + voucherCents;
    if (
      !goodsCents &&
      !depositCents &&
      !returnCents &&
      !tipCents &&
      !voucherCents
    )
      continue;
    const taxCents = input.vatExempt ? 0 : taxOf(grossCents, rate);
    rows.push({
      rate,
      goods: euros(goodsCents),
      deposits: euros(depositCents),
      depositReturns: euros(returnCents),
      tips: euros(tipCents),
      singlePurposeTokens: euros(voucherCents),
      gross: euros(grossCents),
      tax: euros(taxCents),
      net: euros(grossCents - taxCents),
    });
  }
  const sum = (key: keyof Omit<VatReportRow, 'rate'>) =>
    euros(rows.reduce((s, row) => s + Math.round(row[key] * 100), 0));
  return {
    vatExempt: input.vatExempt,
    rows,
    total: {
      goods: sum('goods'),
      deposits: sum('deposits'),
      depositReturns: sum('depositReturns'),
      tips: sum('tips'),
      singlePurposeTokens: sum('singlePurposeTokens'),
      gross: sum('gross'),
      tax: sum('tax'),
      net: sum('net'),
    },
    employeeTips: euros(input.tips?.employeeCents ?? 0),
    multiPurposeTokens: {
      sold: euros(input.tokens?.multiPurposeSoldCents ?? 0),
      boughtBack: euros(input.tokens?.multiPurposeBoughtBackCents ?? 0),
    },
  };
}
