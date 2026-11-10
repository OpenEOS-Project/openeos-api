import type { TsePrintBlock } from '../tse/tse-view';
import {
  euro,
  ratePercent,
  receiptDateTime,
  type ReceiptDocument,
} from './receipt-document';

/**
 * Aufbau eines digitalen Belegs als Folge einfacher Bausteine. Seite,
 * PDF und Mail setzen dieselben Bausteine — so steht ueberall dasselbe,
 * in derselben Reihenfolge wie auf dem gedruckten Bon.
 */
export type ReceiptBlock =
  /** Hervorgehobener Vermerk (TESTMODUS, KOPIE). */
  | { type: 'banner'; text: string }
  /** Kopf: Name des Vereins. */
  | { type: 'heading'; text: string }
  /** Titel eines Belegs (z. B. „BEWIRTUNGSBELEG“). */
  | { type: 'title'; text: string }
  | { type: 'center'; text: string; muted?: boolean }
  | { type: 'text'; text: string; bold?: boolean; muted?: boolean }
  | { type: 'row'; label: string; value: string; bold?: boolean }
  | { type: 'item'; qty: string; name: string; amount: string }
  | { type: 'rule'; double?: boolean }
  /** Lange Werte (Seriennummer, Signatur) in Festbreitenschrift. */
  | { type: 'mono'; label?: string; text: string }
  | { type: 'qr'; value: string; caption?: string }
  /** Leerzeile zum Ausfuellen von Hand (Bewirtungsbeleg). */
  | { type: 'fill'; label: string; lines: number }
  | { type: 'note'; text: string };

/** TSE-Angaben wie auf dem Bon (AEAO zu § 146a Nr. 2.4, § 6 KassenSichV). */
export function tseBlocks(tse: TsePrintBlock | null): ReceiptBlock[] {
  if (!tse) return [];
  const out: ReceiptBlock[] = [{ type: 'rule' }];
  if (tse.failed) {
    out.push(
      { type: 'center', text: 'TSE ausgefallen' },
      { type: 'center', text: 'Beleg ohne Signatur', muted: true },
      { type: 'row', label: 'Kassen-ID', value: tse.client_id },
    );
    if (tse.bon_number)
      out.push({
        type: 'row',
        label: 'Beleg-Nr.',
        value: String(tse.bon_number),
      });
    if (tse.serial_number)
      out.push({
        type: 'mono',
        label: 'TSE-Seriennummer',
        text: tse.serial_number,
      });
    return out;
  }
  if (tse.training)
    out.push({ type: 'banner', text: 'TRAININGSBUCHUNG – KEIN VERKAUF' });
  out.push({ type: 'row', label: 'Kassen-ID', value: tse.client_id });
  if (tse.bon_number)
    out.push({
      type: 'row',
      label: 'Beleg-Nr.',
      value: String(tse.bon_number),
    });
  out.push(
    { type: 'mono', label: 'TSE-Seriennummer', text: tse.serial_number ?? '' },
    {
      type: 'row',
      label: 'TSE-Transaktion',
      value: String(tse.transaction_number ?? ''),
    },
    {
      type: 'row',
      label: 'Signaturzähler',
      value: String(tse.signature_counter ?? ''),
    },
    { type: 'row', label: 'Start', value: tse.start_time ?? '' },
    { type: 'row', label: 'Ende', value: tse.finish_time ?? '' },
    { type: 'row', label: 'Algorithmus', value: tse.signature_algorithm ?? '' },
    { type: 'row', label: 'Zeitformat', value: tse.log_time_format ?? '' },
    { type: 'mono', label: 'Signatur', text: tse.signature ?? '' },
  );
  if (tse.qr_code) out.push({ type: 'qr', value: tse.qr_code });
  return out;
}

/** Kopf mit Name, Anschrift und Telefon des Vereins. */
export function headerBlocks(
  org: ReceiptDocument['organization'],
): ReceiptBlock[] {
  const out: ReceiptBlock[] = [{ type: 'heading', text: org.name }];
  if (org.address) out.push({ type: 'center', text: org.address });
  if (org.phone) out.push({ type: 'center', text: `Tel: ${org.phone}` });
  return out;
}

/** Positionen, Summen, MwSt und Zahlart eines Kassenbelegs. */
export function amountBlocks(doc: ReceiptDocument): ReceiptBlock[] {
  const out: ReceiptBlock[] = [{ type: 'rule' }];
  for (const item of doc.items) {
    out.push({
      type: 'item',
      qty: `${item.quantity}x`,
      name: item.name,
      amount: euro(item.total),
    });
  }
  out.push({ type: 'rule', double: true });
  if (doc.subtotal !== null)
    out.push({
      type: 'row',
      label: 'Zwischensumme',
      value: euro(doc.subtotal),
    });
  if (doc.discount)
    out.push({ type: 'row', label: 'Rabatt', value: euro(-doc.discount) });
  if (doc.pfand)
    out.push({ type: 'row', label: 'Pfand', value: euro(doc.pfand) });
  for (const line of doc.taxLines) {
    out.push({
      type: 'row',
      label: `enth. MwSt ${ratePercent(line.rate)}`,
      value: euro(line.tax),
    });
  }
  out.push({
    type: 'row',
    label: 'GESAMT',
    value: euro(doc.total),
    bold: true,
  });
  return out;
}

export function paymentBlocks(doc: ReceiptDocument): ReceiptBlock[] {
  const out: ReceiptBlock[] = [];
  if (doc.payment.label) {
    out.push({ type: 'rule' });
    out.push({ type: 'row', label: 'Zahlungsart', value: doc.payment.label });
    if (doc.payment.paidAmount !== null)
      out.push({
        type: 'row',
        label: 'Bezahlt',
        value: euro(doc.payment.paidAmount),
      });
    if (doc.payment.change)
      out.push({
        type: 'row',
        label: 'Rückgeld',
        value: euro(doc.payment.change),
      });
  }
  return out;
}

/** Der Kassenbeleg, Baustein fuer Baustein wie `receipt.jinja2`. */
export function receiptBlocks(
  doc: ReceiptDocument,
  timeZone?: string,
): ReceiptBlock[] {
  const out: ReceiptBlock[] = [];
  if (doc.isTest) out.push({ type: 'banner', text: 'TESTMODUS' });
  out.push(...headerBlocks(doc.organization));
  out.push({ type: 'rule', double: true });
  out.push({
    type: 'text',
    text: `Bestellung #${doc.orderNumber}`,
    bold: true,
  });
  out.push({
    type: 'row',
    label: 'Datum',
    value: receiptDateTime(doc.createdAt, timeZone),
  });
  if (doc.tableNumber)
    out.push({ type: 'row', label: 'Tisch', value: doc.tableNumber });
  if (doc.waiterName)
    out.push({ type: 'row', label: 'Bedienung', value: doc.waiterName });
  out.push(...amountBlocks(doc));
  out.push(...paymentBlocks(doc));
  out.push(...tseBlocks(doc.tse));
  out.push({ type: 'rule' });
  out.push({ type: 'center', text: 'Vielen Dank für deinen Einkauf!' });
  return out;
}

/** Text-Fassung (Mail ohne HTML, Tests). */
export function blocksToText(blocks: ReceiptBlock[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'banner':
        lines.push(`*** ${b.text} ***`);
        break;
      case 'heading':
      case 'title':
      case 'center':
      case 'text':
      case 'note':
        lines.push(b.text);
        break;
      case 'row':
        lines.push(`${b.label}: ${b.value}`);
        break;
      case 'item':
        lines.push(`${b.qty} ${b.name}  ${b.amount}`);
        break;
      case 'rule':
        lines.push(b.double ? '========' : '--------');
        break;
      case 'mono':
        lines.push(b.label ? `${b.label}: ${b.text}` : b.text);
        break;
      case 'qr':
        if (b.caption) lines.push(b.caption);
        break;
      case 'fill':
        lines.push(`${b.label}: ______________________`);
        for (let i = 1; i < b.lines; i++) lines.push('______________________');
        break;
    }
  }
  return lines.join('\n');
}
