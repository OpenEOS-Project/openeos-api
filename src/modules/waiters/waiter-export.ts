import { printDateTime } from './waiter-settlements.service';

type WaiterExport = Awaited<
  ReturnType<import('./waiters.service').WaitersService['exportData']>
>;

const BOOKING_LABELS: Record<string, string> = {
  ordersTaken: 'Bestellungen aufgenommen',
  ordersResponsible: 'Bestellungen verantwortlich (Tische)',
  itemsSent: 'Positionen gesendet (Runden)',
  paymentsProcessed: 'Zahlungen kassiert',
  refundsTriggered: 'Stornos/Erstattungen ausgelöst',
  refundsApproved: 'Stornos/Erstattungen freigegeben',
  pfandReturns: 'Pfand-Auszahlungen',
  orderEvents: 'Einträge im Bestellverlauf',
  cashbookEntries: 'Kassenbuch-Einträge',
  fiscalTransactions: 'Vorgänge im Steuerarchiv (TSE)',
};

function cell(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ''
      : value instanceof Date
        ? printDateTime(value)
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value as string | number | boolean);
  return /[;"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Auskunft als CSV: Bereich;Feld;Wert (Excel-tauglich, UTF-8 mit BOM). */
export function waiterExportCsv(data: WaiterExport): string {
  const rows: unknown[][] = [['Bereich', 'Feld', 'Wert']];
  const w = data.waiter;
  const master: [string, unknown][] = [
    ['Name', w.name],
    ['Kurzname', w.shortName],
    ['Farbe', w.color],
    ['Rolle', w.role === 'lead' ? 'Schichtleitung' : 'Bedienung'],
    [
      'Rechte',
      Object.entries(w.permissions)
        .filter(([, on]) => on)
        .map(([key]) => key)
        .join(', '),
    ],
    ['Veranstaltung', w.event ?? 'organisationsweit'],
    ['Aktiv', w.isActive ? 'ja' : 'nein'],
    ['PIN vergeben', w.hasPin ? 'ja (nur Prüfwert gespeichert)' : 'nein'],
    ['Angelegt', w.createdAt],
    ['Zuletzt angemeldet', w.lastUsedAt],
    ['Anonymisiert', w.anonymizedAt],
    ['Wird anonymisiert ab', w.anonymizeDueAt],
  ];
  for (const [field, value] of master) rows.push(['Stammdaten', field, value]);
  for (const s of data.sessions) {
    rows.push([
      'Anmeldung',
      s.device ?? 'Gerät',
      `${printDateTime(s.startedAt)} – ${printDateTime(s.endedAt ?? s.lastSeenAt)}${s.endReason ? ` (${s.endReason})` : ''}`,
    ]);
  }
  for (const s of data.settlements) {
    rows.push([
      'Abrechnung',
      s.number ? `Nr. ${s.number}` : 'Training',
      `${printDateTime(s.createdAt)}${s.event ? `, ${s.event}` : ''}${s.cashExpected !== null ? `, Soll bar ${s.cashExpected.toFixed(2).replace('.', ',')}` : ''}${s.forced ? ', trotz offener Tische' : ''}`,
    ]);
  }
  for (const [key, value] of Object.entries(data.bookings)) {
    rows.push(['Buchungen', BOOKING_LABELS[key] ?? key, value]);
  }
  for (const note of data.notes) rows.push(['Hinweis', '', note]);
  return '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}
