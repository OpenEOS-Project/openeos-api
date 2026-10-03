import { PaymentMethod } from '../../database/entities/payment.entity';
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
 * Bewusst nicht aus `order.taxTotal`: das rechnet `Preis * Satz / 100`, als
 * waeren die Preise netto — sie sind aber brutto (der Gesamtbetrag ist
 * Zwischensumme ohne Aufschlag). Ausserdem setzt der Shop-Checkout
 * `taxTotal` auf 0. Im Bruttopreis enthalten ist `Preis * Satz / (100 + Satz)`.
 *
 * - Pfand steckt nicht in `totalPrice` (es liegt in `depositAmount`) und ist
 *   keine Lieferung, also auch nicht steuerbar — es bleibt hier aussen vor.
 * - Ein Rabatt mindert das Entgelt. Er gilt fuer die ganze Bestellung, also
 *   wird er anteilig auf die Saetze verteilt.
 * - Trinkgeld geht an das Personal und zaehlt nicht zum Entgelt.
 * - Steuerbefreite Organisationen (Kleinunternehmer, viele Vereine) duerfen
 *   keine MwSt ausweisen. Wie bei `taxRatesFor` gilt nur ein ausdrueckliches
 *   `vatExempt: false` als steuerpflichtig.
 */
export function buildReceiptTax(
  items: Pick<OrderItem, 'totalPrice' | 'taxRate' | 'status'>[],
  discountAmount: number | null | undefined,
  vatExempt: boolean | undefined,
): ReceiptTax {
  if (vatExempt !== false) return {};

  const grossByRate = new Map<number, number>();
  let subtotal = 0;
  for (const item of items) {
    if (item.status === OrderItemStatus.CANCELLED) continue;
    const gross = Number(item.totalPrice) || 0;
    const rate = Number(item.taxRate) || 0;
    subtotal += gross;
    grossByRate.set(rate, (grossByRate.get(rate) ?? 0) + gross);
  }

  const discount = Math.min(Math.max(Number(discountAmount) || 0, 0), subtotal);
  const factor = subtotal > 0 ? (subtotal - discount) / subtotal : 0;

  const lines: ReceiptTaxLine[] = [...grossByRate.entries()]
    // Positionen mit 0 % tragen keine Steuer und brauchen keine eigene Zeile.
    .filter(([rate]) => rate > 0)
    .sort(([a], [b]) => b - a)
    .map(([rate, sum]) => {
      const gross = round2(sum * factor);
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
