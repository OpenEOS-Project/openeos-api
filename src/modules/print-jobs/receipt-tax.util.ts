import { PaymentMethod } from '../../database/entities/payment.entity';
import {
  depositRateOf,
  tipByRate,
  type ServiceFeeLine,
} from '../refunds/refund-calc';
import {
  OrderItem,
  OrderItemStatus,
} from '../../database/entities/order-item.entity';

/** Eine MwSt-Zeile je Steuersatz, so wie sie auf dem Bon steht. */
export interface ReceiptTaxLine {
  rate: number;
  net: number;
  tax: number;
  gross: number;
}

export interface ReceiptTax {
  /** Summe aller Steuerbetraege; fehlt, wenn keine MwSt auszuweisen ist. */
  tax_amount?: number;
  /** Nur gesetzt, wenn alle besteuerten Positionen denselben Satz haben. */
  tax_rate?: number;
  tax_lines?: ReceiptTaxLine[];
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * MwSt fuer den Bon aus den Positionen berechnen.
 *
 * Die Preise sind brutto (der Gesamtbetrag ist die Zwischensumme ohne
 * Aufschlag), enthalten ist also `Preis * Satz / (100 + Satz)`. Dieselbe
 * Rechnung liefert ueber `orderTaxTotal` auch `order.taxTotal`; gerechnet
 * wird hier trotzdem aus den Positionen, weil der Bon die Saetze einzeln
 * braucht.
 *
 * - Pfand steckt nicht in `totalPrice` (es liegt in `depositAmount`), gehoert
 *   aber zum Entgelt (Abschn. 10.1 Abs. 8 UStAE): es zaehlt zum Satz seiner
 *   Pfandart (`depositTaxRate`, Snapshot beim Verkauf). Positionen von vor
 *   der Umstellung (2026-11) haben keinen Satz — ihr Pfand bleibt wie
 *   damals nicht steuerbar (0 %), ein Nachdruck sieht also aus wie das
 *   Original.
 * - Ein Rabatt mindert das Entgelt. Er gilt fuer die Waren der Bestellung
 *   (wie `order.total`: Rabatt hoechstens bis zur Zwischensumme, Pfand
 *   bleibt voll), also wird er anteilig auf die Warensaetze verteilt.
 * - Trinkgeld an den umsatzsteuerpflichtigen Verein ist Entgelt
 *   (Abschn. 10.1 Abs. 5 UStAE) und teilt den Satz der Hauptleistung:
 *   anteilig nach den Nettoentgelten der Waren je Satz (`tipByRate`).
 *   Trinkgeld einer angestellten Bedienung (TrinkgeldAN) bleibt aussen vor
 *   (`tip.toClub = false`). Steuerberater 2026-11-10, Fragen 3–5.
 * - Die Servicegebuehr des Shops ist eine eigene Leistung mit eigenem Satz
 *   (`serviceFee`, Standard 19 %); ein Rabatt mindert sie nicht.
 * - Steuerbefreite Organisationen (Kleinunternehmer, viele Vereine) duerfen
 *   keine MwSt ausweisen. Wie bei `taxRatesFor` gilt nur ein ausdrueckliches
 *   `vatExempt: false` als steuerpflichtig.
 */
export type ReceiptTaxItem = Pick<
  OrderItem,
  'totalPrice' | 'taxRate' | 'status'
> &
  Partial<Pick<OrderItem, 'quantity' | 'depositAmount' | 'depositTaxRate'>>;

/** § 19-Hinweis auf jedem Beleg eines Kleinunternehmers (§ 34a UStDV). */
export const VAT_EXEMPT_NOTICE =
  'Steuerfrei nach § 19 Abs. 1 UStG (Kleinunternehmer)';

/**
 * `vat_exempt_notice` fuer Bon und Gegenbeleg: bei steuerbefreiten
 * Organisationen (nur ein ausdrueckliches `vatExempt: false` ist
 * steuerpflichtig) immer, sonst nichts (§ 6 Satz 1 Nr. 5 KassenSichV, AEAO
 * zu § 146a Nr. 2.4.4 Nr. 5, § 34a UStDV). Nie Steuerbetraege (§ 14c UStG).
 */
export function vatExemptNotice(vatExempt: boolean | undefined): {
  vat_exempt_notice?: string;
} {
  return vatExempt !== false ? { vat_exempt_notice: VAT_EXEMPT_NOTICE } : {};
}

export function buildReceiptTax(
  items: ReceiptTaxItem[],
  discountAmount: number | null | undefined,
  vatExempt: boolean | undefined,
  /** Trinkgeld der Bestellung; `toClub` = TrinkgeldAG (Entgelt). */
  tip: { amount: number | null | undefined; toClub: boolean } | null = null,
  /** Servicegebuehr (Shop) mit eigenem Satz. */
  serviceFee: ServiceFeeLine | null = null,
): ReceiptTax {
  if (vatExempt !== false) return {};

  const grossByRate = new Map<number, number>();
  const depositByRate = new Map<number, number>();
  let subtotal = 0;
  for (const item of items) {
    if (item.status === OrderItemStatus.CANCELLED) continue;
    const gross = Number(item.totalPrice) || 0;
    const rate = Number(item.taxRate) || 0;
    subtotal += gross;
    grossByRate.set(rate, (grossByRate.get(rate) ?? 0) + gross);
    const deposit = (Number(item.depositAmount) || 0) * (item.quantity ?? 0);
    if (deposit) {
      const depositRate = depositRateOf(item);
      depositByRate.set(
        depositRate,
        (depositByRate.get(depositRate) ?? 0) + deposit,
      );
    }
  }

  const discount = Math.min(Math.max(Number(discountAmount) || 0, 0), subtotal);
  const factor = subtotal > 0 ? (subtotal - discount) / subtotal : 0;

  // Trinkgeld an den Verein anteilig auf die Warensaetze (nach Rabatt).
  const tipByRateEuro = new Map<number, number>();
  const tipCents = Math.round((Number(tip?.amount) || 0) * 100);
  if (tip?.toClub && tipCents > 0) {
    const goodsCents = new Map<number, number>();
    for (const [rate, gross] of grossByRate) {
      goodsCents.set(rate, Math.round(gross * factor * 100));
    }
    for (const [rate, value] of tipByRate(goodsCents, tipCents)) {
      tipByRateEuro.set(rate, value / 100);
    }
  }

  const feeByRate = new Map<number, number>();
  if (serviceFee && serviceFee.amount > 0) {
    feeByRate.set(serviceFee.rate, serviceFee.amount);
  }

  const rates = new Set([
    ...grossByRate.keys(),
    ...depositByRate.keys(),
    ...tipByRateEuro.keys(),
    ...feeByRate.keys(),
  ]);
  const lines: ReceiptTaxLine[] = [...rates]
    // Positionen mit 0 % tragen keine Steuer und brauchen keine eigene Zeile.
    .filter((rate) => rate > 0)
    .sort((a, b) => b - a)
    .map((rate) => {
      const gross = round2(
        (grossByRate.get(rate) ?? 0) * factor +
          (depositByRate.get(rate) ?? 0) +
          (tipByRateEuro.get(rate) ?? 0) +
          (feeByRate.get(rate) ?? 0),
      );
      const tax = round2((gross * rate) / (100 + rate));
      return { rate, net: round2(gross - tax), tax, gross };
    })
    .filter((line) => line.gross > 0);

  if (lines.length === 0) return {};

  return {
    tax_amount: round2(lines.reduce((acc, line) => acc + line.tax, 0)),
    tax_rate: lines.length === 1 ? lines[0].rate : undefined,
    tax_lines: lines,
  };
}

/**
 * Rueckgeld einer Barzahlung. Nur bekannt, wenn die Kasse den erhaltenen
 * Betrag mitgeschickt hat (`payment.metadata.amountReceived`).
 */
export function cashChange(
  paymentMethod: string,
  amount: number,
  amountReceived: unknown,
): number | undefined {
  if (paymentMethod !== (PaymentMethod.CASH as string)) return undefined;
  if (typeof amountReceived !== 'number' || !Number.isFinite(amountReceived)) {
    return undefined;
  }
  const change = round2(amountReceived - Number(amount));
  return change > 0 ? change : undefined;
}

/**
 * Metadaten fuer eine neue Zahlung: bei Barzahlung den erhaltenen Betrag
 * festhalten, damit der Bon (auch beim Nachdruck) das Rueckgeld kennt.
 * Weniger als den Zahlbetrag zu erhalten ergibt kein Rueckgeld — dann wird
 * auch nichts gespeichert.
 */
export function cashReceivedMetadata(
  paymentMethod: string,
  amount: number,
  amountReceived: number | undefined,
): { amountReceived?: number } {
  if (paymentMethod !== (PaymentMethod.CASH as string)) return {};
  if (typeof amountReceived !== 'number' || !Number.isFinite(amountReceived)) {
    return {};
  }
  if (amountReceived < Number(amount)) return {};
  return { amountReceived: round2(amountReceived) };
}

/**
 * `order.taxTotal` — dieselbe Rechnung wie auf dem Bon, damit Beleg und
 * gespeicherte Summe nicht auseinanderlaufen koennen: im Bruttopreis
 * enthaltene Steuer je Satz, Rabatt anteilig, Pfand mit dem Satz seiner
 * Pfandart (Bestand: 0 %), Servicegebuehr mit ihrem Satz, Trinkgeld
 * aussen vor, und 0 fuer jede Organisation, die nicht ausdruecklich
 * `vatExempt: false` hat.
 */
export function orderTaxTotal(
  items: ReceiptTaxItem[],
  discountAmount: number | null | undefined,
  vatExempt: boolean | undefined,
  serviceFee: ServiceFeeLine | null = null,
): number {
  return (
    buildReceiptTax(items, discountAmount, vatExempt, null, serviceFee)
      .tax_amount ?? 0
  );
}
