import type { TsePrintBlock } from '../tse/tse-view';
import type { ReceiptTaxLine } from '../print-jobs/receipt-tax.util';

/**
 * Digitaler Kassenbeleg: dieselben Angaben wie der gedruckte Bon
 * (`receipt`-Vorlage), gebaut aus demselben Druckauftrag
 * (`OrderPrintService.receiptPayload`). So koennen gedruckter und digitaler
 * Beleg nicht auseinanderlaufen.
 *
 * Bewusst NICHT enthalten (keine personenbezogenen Daten auf einer per Link
 * erreichbaren Seite): Name des Gastes (`customer_name`), Hinweise zu
 * Positionen (`notes`, Freitext der Bestellung). Die Bedienung steht nur
 * drauf, wenn die Bon-Vorlage der Organisation sie auch druckt.
 */
export interface ReceiptDocumentLine {
  quantity: number;
  name: string;
  total: number;
}

export interface ReceiptDocument {
  orderId: string;
  orderNumber: string;
  dailyNumber: number | null;
  /** Datum auf dem Bon (Anlage der Bestellung, wie gedruckt), ISO 8601. */
  createdAt: string | null;
  isTest: boolean;
  organization: { name: string; address: string | null; phone: string | null };
  tableNumber: string | null;
  /** Nur, wenn die Bon-Vorlage „Bedienung“ druckt. */
  waiterName: string | null;
  items: ReceiptDocumentLine[];
  subtotal: number | null;
  discount: number | null;
  pfand: number | null;
  /** Trinkgeld (steckt in `total`; an den Verein auch in der MwSt). */
  tip: number | null;
  /** MwSt je Satz; leer bei steuerbefreiten Organisationen (§ 19 UStG). */
  taxLines: ReceiptTaxLine[];
  /** Kleinunternehmer: Hinweis auf die Steuerbefreiung (§ 34a UStDV). */
  vatExemptNotice: string | null;
  total: number;
  payment: {
    method: string | null;
    label: string | null;
    paidAmount: number | null;
    change: number | null;
  };
  /** TSE-Angaben wie auf dem Bon (null ohne Cloud-TSE). */
  tse: TsePrintBlock | null;
}

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/**
 * Druckauftrag des Kassenbons → digitaler Beleg. `showWaiter`: druckt die
 * Bon-Vorlage der Organisation die Bedienung?
 */
export function receiptDocumentFromPayload(
  payload: Record<string, unknown>,
  options: { showWaiter: boolean },
): ReceiptDocument {
  const org = (payload.organization ?? {}) as {
    name?: string;
    address?: string;
    phone?: string;
  };
  const items = Array.isArray(payload.items)
    ? (payload.items as Record<string, unknown>[])
    : [];
  const discount = num(payload.discount_amount);
  const pfand = num(payload.pfand_total);
  const tip = num(payload.tip_amount);
  const change = num(payload.change);
  return {
    orderId: str(payload.order_id) ?? '',
    orderNumber: str(payload.order_number) ?? '',
    dailyNumber: num(payload.daily_number),
    createdAt: iso(payload.created_at),
    isTest: payload.is_test === true,
    organization: {
      name: str(org.name) ?? 'OpenEOS',
      address: str(org.address),
      phone: str(org.phone),
    },
    tableNumber: str(payload.table_number),
    waiterName: options.showWaiter ? str(payload.waiter_name) : null,
    items: items.map((it) => ({
      quantity: Number(it.quantity) || 0,
      name: str(it.name) ?? '',
      total: num(it.total) ?? 0,
    })),
    subtotal: num(payload.subtotal),
    discount: discount && discount > 0 ? discount : null,
    pfand: pfand && pfand > 0 ? pfand : null,
    tip: tip && tip > 0 ? tip : null,
    taxLines: Array.isArray(payload.tax_lines)
      ? (payload.tax_lines as ReceiptTaxLine[])
      : [],
    vatExemptNotice: str(payload.vat_exempt_notice),
    total: num(payload.total) ?? 0,
    payment: {
      method: str(payload.payment_method),
      label: str(payload.payment_label) ?? str(payload.payment_method),
      paidAmount: num(payload.paid_amount),
      change: change && change > 0 ? change : null,
    },
    tse: (payload.tse as TsePrintBlock | null | undefined) ?? null,
  };
}

/** „12,50 €“ wie auf dem Bon (de-DE). */
export function euro(value: number): string {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
  }).format(value);
}

/** „11.11.2026 14:05“ in der Zeitzone der Organisation. */
export function receiptDateTime(
  value: string | null,
  timeZone = 'Europe/Berlin',
): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('de-DE', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')}.${get('month')}.${get('year')} ${get('hour')}:${get('minute')}`;
}

/** „19 %“ bzw. „7 %“ (ohne „,0“). */
export function ratePercent(rate: number): string {
  return `${Number.isInteger(rate) ? rate : String(rate).replace('.', ',')} %`;
}
