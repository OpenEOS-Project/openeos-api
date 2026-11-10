import type { TsePrintBlock } from '../tse/tse-view';
import type { ReceiptTaxLine } from '../print-jobs/receipt-tax.util';
import { headerBlocks, tseBlocks, type ReceiptBlock } from './receipt-blocks';
import { euro, ratePercent, type ReceiptDocument } from './receipt-document';

/**
 * Bewirtungsbeleg (openeos-web#9): Rechnung ueber eine Bewirtung nach
 * § 14 UStG bzw. § 33 UStDV mit den Angaben, die BMF-Schreiben vom
 * 19.11.2025 (IV C 6 - S 2145/00026/005/033, ersetzt fuer Bewirtungen ab
 * 2025 das Schreiben vom 30.06.2021) und R 4.10 Abs. 8 EStR verlangen,
 * plus einem Abschnitt fuer die Eigenangaben des Bewirtenden (Anlass,
 * Teilnehmer, Unterschrift — handschriftlich erlaubt).
 *
 * Reine Funktionen: Pruefungen, Schnappschuss, Bausteine.
 */

/** Kleinbetragsrechnung bis einschliesslich 250 € brutto (§ 33 UStDV). */
export const SMALL_INVOICE_LIMIT = 250;

/** Stammdaten des Vereins auf dem Beleg. */
export interface HospitalityIssuer {
  legalName: string;
  street: string;
  zip: string;
  city: string;
  taxNumber: string;
  vatId: string;
}

export type HospitalityMasterField =
  | 'legalName'
  | 'street'
  | 'zip'
  | 'city'
  | 'taxNumber';

/**
 * Was fehlt: Name und Anschrift immer (§ 33 Nr. 1 UStDV, Rn. 4), Steuer-
 * nummer oder USt-IdNr. ueber 250 € (§ 14 Abs. 4 Nr. 2 UStG, Rn. 10).
 */
export function missingIssuerData(
  issuer: HospitalityIssuer,
  total: number,
): HospitalityMasterField[] {
  const missing: HospitalityMasterField[] = [];
  if (!issuer.legalName) missing.push('legalName');
  if (!issuer.street) missing.push('street');
  if (!issuer.zip) missing.push('zip');
  if (!issuer.city) missing.push('city');
  if (total > SMALL_INVOICE_LIMIT && !issuer.taxNumber && !issuer.vatId) {
    missing.push('taxNumber');
  }
  return missing;
}

/**
 * Sammelbezeichnungen, die als Leistungsbeschreibung nicht reichen
 * (R 4.10 Abs. 8 Satz 9 EStR, BMF 19.11.2025 Rn. 6: „Speisen und
 * Getränke“ oder nur der Gesamtbetrag genuegen nicht; „Menü 1“,
 * „Tagesgericht 2“, „Lunch-Buffet“ schon).
 */
const COLLECTIVE =
  /^(speisen|getr(ä|ae)nke|essen|trinken|speisen\s*(und|&|\+|u\.?)\s*getr(ä|ae)nke|essen\s*(und|&|\+|u\.?)\s*trinken|getr(ä|ae)nke\s*(und|&|\+|u\.?)\s*speisen|verzehr|bewirtung|diverses|div\.?|sonstiges|artikel|position|food|drinks?|food\s*(and|&)\s*drinks?)$/i;

export function isCollectiveItemName(name: string): boolean {
  const n = name
    .trim()
    .replace(/[.:!]+$/, '')
    .replace(/\s+/g, ' ');
  return n.length === 0 || COLLECTIVE.test(n);
}

export function collectiveItemNames(names: string[]): string[] {
  return [...new Set(names.filter(isCollectiveItemName))];
}

/** Zahlung eines Belegs (Trinkgeld, Referenz des Terminals/Anbieters). */
export interface HospitalityPayment {
  tip: number;
  reference: string | null;
}

/** Alles, was auf dem Bewirtungsbeleg steht (unveraenderlich gespeichert). */
export interface HospitalitySnapshot {
  version: 1;
  issuer: HospitalityIssuer;
  /** Steuerbefreit (Kleinunternehmer § 19 UStG): kein Steuerausweis. */
  vatExempt: boolean;
  orderNumbers: string[];
  /** Datum des Kassenbelegs (Bestellung), ISO. */
  receiptDate: string | null;
  items: { quantity: number; name: string; total: number }[];
  pfand: number;
  discount: number;
  taxLines: ReceiptTaxLine[];
  /** Rechnungsbetrag brutto ohne Trinkgeld. */
  total: number;
  tip: number;
  paymentLabels: string[];
  paymentReferences: string[];
  /** Nur unbare Zahlung moeglich (Betriebsart „Bargeldlos“, Rn. 16). */
  cashlessOnly: boolean;
  tse: TsePrintBlock[];
  isTest: boolean;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Schnappschuss aus den Kassenbelegen der Bestellungen. */
export function hospitalitySnapshot(input: {
  issuer: HospitalityIssuer;
  vatExempt: boolean;
  cashlessOnly: boolean;
  documents: ReceiptDocument[];
  payments: HospitalityPayment[];
}): HospitalitySnapshot {
  const docs = input.documents;
  const items = docs.flatMap((d) =>
    d.items.map((it) => ({
      quantity: it.quantity,
      name: it.name,
      total: it.total,
    })),
  );
  const byRate = new Map<number, ReceiptTaxLine>();
  for (const line of docs.flatMap((d) => d.taxLines)) {
    const prev = byRate.get(line.rate);
    byRate.set(
      line.rate,
      prev
        ? {
            rate: line.rate,
            net: round2(prev.net + line.net),
            tax: round2(prev.tax + line.tax),
            gross: round2(prev.gross + line.gross),
          }
        : { ...line },
    );
  }
  const labels = [
    ...new Set(docs.map((d) => d.payment.label).filter(Boolean)),
  ] as string[];
  const references = [
    ...new Set(input.payments.map((p) => p.reference?.trim()).filter(Boolean)),
  ] as string[];
  const dates = docs.map((d) => d.createdAt).filter(Boolean) as string[];
  return {
    version: 1,
    issuer: input.issuer,
    vatExempt: input.vatExempt,
    orderNumbers: docs.map((d) => d.orderNumber),
    receiptDate: dates.sort()[0] ?? null,
    items,
    pfand: round2(docs.reduce((s, d) => s + (d.pfand ?? 0), 0)),
    discount: round2(docs.reduce((s, d) => s + (d.discount ?? 0), 0)),
    // Steuerbefreit: keine MwSt-Zeilen (§ 14c UStG), auch wenn welche kaemen.
    taxLines: input.vatExempt
      ? []
      : [...byRate.values()].sort((a, b) => b.rate - a.rate),
    total: round2(docs.reduce((s, d) => s + d.total, 0)),
    tip: round2(input.payments.reduce((s, p) => s + (Number(p.tip) || 0), 0)),
    paymentLabels: labels,
    paymentReferences: references,
    cashlessOnly: input.cashlessOnly,
    tse: docs.map((d) => d.tse).filter((t): t is TsePrintBlock => !!t),
    isTest: docs.some((d) => d.isTest),
  };
}

/** „11.11.2026“ */
export function dateDe(
  value: string | Date | null,
  timeZone = 'Europe/Berlin',
): string {
  if (!value) return '';
  // Reines Datum (JJJJ-MM-TT) ohne Zeitzonenverschiebung.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-');
    return `${d}.${m}.${y}`;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('de-DE', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

/** Kalendertag (JJJJ-MM-TT) eines Zeitpunkts in der Zeitzone. */
export function dayKey(
  value: string | Date,
  timeZone = 'Europe/Berlin',
): string {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  return parts;
}

export interface HospitalityRecordView {
  number: string | null;
  issuedAt: Date | string;
  serviceDate: string;
  recipientName: string | null;
  recipientAddress: string | null;
  snapshot: HospitalitySnapshot;
}

/** Hinweis bei steuerbefreiten Vereinen (§ 34a UStDV, kein Steuerausweis). */
export const VAT_EXEMPT_NOTE =
  'Steuerfrei gem. § 19 UStG (Kleinunternehmerregelung).';

/**
 * Der Bewirtungsbeleg als Bausteine (Seite, PDF, Mail, Druck). `copy`:
 * Nachdruck bzw. erneute Ausgabe („KOPIE“).
 */
export function hospitalityBlocks(
  record: HospitalityRecordView,
  options: { copy: boolean; timeZone?: string },
): ReceiptBlock[] {
  const s = record.snapshot;
  const tz = options.timeZone;
  const out: ReceiptBlock[] = [];
  if (s.isTest)
    out.push({ type: 'banner', text: 'TESTBELEG – KEIN BEWIRTUNGSBELEG' });
  const address = [
    s.issuer.street,
    [s.issuer.zip, s.issuer.city].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .join(', ');
  out.push(
    ...headerBlocks({
      name: s.issuer.legalName,
      address: address || null,
      phone: null,
    }),
  );
  if (s.issuer.taxNumber)
    out.push({ type: 'center', text: `Steuernummer: ${s.issuer.taxNumber}` });
  if (s.issuer.vatId)
    out.push({ type: 'center', text: `USt-IdNr.: ${s.issuer.vatId}` });
  out.push({ type: 'rule', double: true });
  out.push({ type: 'title', text: 'BEWIRTUNGSBELEG' });
  if (options.copy) out.push({ type: 'banner', text: 'KOPIE' });
  out.push({
    type: 'row',
    label: 'Rechnungsnummer',
    value: record.number ?? 'TEST',
  });
  out.push({
    type: 'row',
    label: 'Rechnungsdatum',
    value: dateDe(record.issuedAt as string, tz),
  });
  out.push({
    type: 'row',
    label: 'Tag der Bewirtung',
    value: dateDe(record.serviceDate),
  });
  out.push({
    type: 'row',
    label: s.orderNumbers.length > 1 ? 'Bestellungen' : 'Bestellung',
    value: s.orderNumbers.map((n) => `#${n}`).join(', '),
  });
  if (record.recipientName) {
    out.push({ type: 'rule' });
    out.push({
      type: 'text',
      text: 'Leistungsempfänger (Bewirtende/r):',
      muted: true,
    });
    out.push({ type: 'text', text: record.recipientName, bold: true });
    if (record.recipientAddress) {
      for (const line of record.recipientAddress.split(/\n+/)) {
        if (line.trim()) out.push({ type: 'text', text: line.trim() });
      }
    }
  }
  out.push({ type: 'rule' });
  for (const item of s.items) {
    out.push({
      type: 'item',
      qty: `${item.quantity}x`,
      name: item.name,
      amount: euro(item.total),
    });
  }
  if (s.pfand)
    out.push({ type: 'item', qty: '', name: 'Pfand', amount: euro(s.pfand) });
  if (s.discount)
    out.push({
      type: 'item',
      qty: '',
      name: 'Rabatt',
      amount: euro(-s.discount),
    });
  out.push({ type: 'rule', double: true });
  if (s.vatExempt || s.taxLines.length === 0) {
    out.push({
      type: 'row',
      label: 'Rechnungsbetrag',
      value: euro(s.total),
      bold: true,
    });
    if (s.vatExempt) out.push({ type: 'note', text: VAT_EXEMPT_NOTE });
  } else {
    for (const line of s.taxLines) {
      out.push({
        type: 'row',
        label: `Netto ${ratePercent(line.rate)}`,
        value: euro(line.net),
      });
      out.push({
        type: 'row',
        label: `USt ${ratePercent(line.rate)}`,
        value: euro(line.tax),
      });
    }
    const net = round2(s.taxLines.reduce((a, l) => a + l.net, 0));
    const untaxed = round2(
      s.total - s.taxLines.reduce((a, l) => a + l.gross, 0),
    );
    if (untaxed > 0)
      out.push({
        type: 'row',
        label: 'Nicht steuerbar / 0 %',
        value: euro(untaxed),
      });
    out.push({
      type: 'row',
      label: 'Summe netto',
      value: euro(round2(net + Math.max(untaxed, 0))),
    });
    out.push({
      type: 'row',
      label: 'Summe USt',
      value: euro(round2(s.taxLines.reduce((a, l) => a + l.tax, 0))),
    });
    out.push({
      type: 'row',
      label: 'Rechnungsbetrag brutto',
      value: euro(s.total),
      bold: true,
    });
  }
  if (s.tip > 0) {
    out.push({ type: 'row', label: 'Trinkgeld', value: euro(s.tip) });
    out.push({
      type: 'row',
      label: 'Gesamt inkl. Trinkgeld',
      value: euro(round2(s.total + s.tip)),
      bold: true,
    });
  }
  out.push({ type: 'rule' });
  if (s.paymentLabels.length) {
    out.push({
      type: 'row',
      label: 'Zahlungsart',
      value: s.paymentLabels.join(', '),
    });
  }
  for (const ref of s.paymentReferences) {
    out.push({ type: 'row', label: 'Zahlungsreferenz', value: ref });
  }
  if (s.cashlessOnly) {
    out.push({
      type: 'note',
      text: 'Ausschließlich unbare Zahlung. Bitte den Zahlungsbeleg (Karten- bzw. Zahlungsnachweis) beifügen.',
    });
  }
  for (const tse of s.tse) out.push(...tseBlocks(tse));
  out.push({ type: 'rule', double: true });
  out.push({
    type: 'text',
    text: 'Angaben zum Nachweis von Bewirtungsaufwendungen',
    bold: true,
  });
  out.push({
    type: 'note',
    text: '(§ 4 Abs. 5 Satz 1 Nr. 2 EStG) – vom Bewirtenden auszufüllen und zu unterschreiben.',
  });
  out.push({
    type: 'row',
    label: 'Höhe der Aufwendungen',
    value: euro(round2(s.total + s.tip)),
  });
  out.push({ type: 'fill', label: 'Anlass der Bewirtung', lines: 2 });
  out.push({ type: 'fill', label: 'Bewirtete Personen (Namen)', lines: 4 });
  out.push({ type: 'fill', label: 'Ort, Datum', lines: 1 });
  out.push({ type: 'fill', label: 'Unterschrift des Bewirtenden', lines: 1 });
  out.push({
    type: 'note',
    text: 'Maschinell erstellt und elektronisch aufgezeichnet. Von Hand nur die Angaben des Bewirtenden ergänzen.',
  });
  return out;
}

/**
 * Text fuer den Bondrucker: Umlaute und Sonderzeichen wie in den
 * uebrigen mitgelieferten Vorlagen (ASCII, „EUR“ statt €).
 */
export function printableText(text: string): string {
  return text
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe')
    .replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss')
    .replace(/\u00a0/g, ' ')
    .replace(/\s?€/g, ' EUR')
    .replace(/[–—]/g, '-')
    .replace(/[„“”]/g, '"')
    .replace(/§/g, 'Par.');
}

/** Bausteine fuer den Druckauftrag (ASCII). */
export function printableBlocks(blocks: ReceiptBlock[]): ReceiptBlock[] {
  return blocks.map((b) => {
    const copy: Record<string, unknown> = { ...b };
    for (const key of [
      'text',
      'label',
      'value',
      'name',
      'amount',
      'qty',
      'caption',
    ]) {
      if (
        typeof copy[key] === 'string' &&
        !(b.type === 'qr' && key === 'value')
      ) {
        copy[key] = printableText(copy[key]);
      }
    }
    return copy as ReceiptBlock;
  });
}
