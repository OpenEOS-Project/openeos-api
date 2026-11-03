import { TSE_TIME_ZONE } from '../tse/tse-dates';
import { TABLE_BY_NAME, type TableName } from './dsfinvk-schema';

/**
 * Darstellungsregeln der DSFinV-K-CSV-Dateien laut amtlicher index.xml:
 *
 * - UTF-8 (`<UTF8 />`), Spaltentrenner `;`, Datensatztrenner CR LF,
 *   Textbegrenzer `"` (im Text verdoppelt), erste Zeile = Spaltennamen
 *   (`<Range><From>2</From>`).
 * - Zahlen mit Dezimalkomma (`<DecimalSymbol>,</DecimalSymbol>`), ohne
 *   Tausendertrenner, Minus vorangestellt. Betraege immer mit zwei
 *   Nachkommastellen (DSFinV-K Tz. 4.1: „Die Darstellung aller Betraege
 *   erfolgt mit zwei Dezimalstellen“; fuenf sind nur technisch erlaubt),
 *   Mengen mit drei.
 * - Zeitpunkte nach ISO 8601/RFC 3339 (Anhang E, Z_ERSTELLUNG/BON_START),
 *   TSE-Log-Zeiten als `YYYY-MM-DDThh:mm:ss.fffZ` (Anhang E, TSE_TA_START).
 *
 * Alle Betraege werden in Cent (ganze Zahlen) gerechnet.
 */

export const CSV_DELIMITER = ';';
export const CSV_RECORD_DELIMITER = '\r\n';

/** Eine Zeile einer Tabelle: formatierte Werte in Spaltenreihenfolge. */
export type CsvRow = string[];

/** Cent → `12,50`, `-0,05`, `0,00`. */
export function formatAmount(cents: number): string {
  const value = Math.round(cents);
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

/** Menge (bis drei Nachkommastellen) → `2,000`, `-1,500`. */
export function formatQuantity(quantity: number): string {
  const milli = Math.round(quantity * 1000);
  const sign = milli < 0 ? '-' : '';
  const abs = Math.abs(milli);
  return `${sign}${Math.floor(abs / 1000)},${String(abs % 1000).padStart(3, '0')}`;
}

export function formatInteger(value: number | string): string {
  return String(Math.trunc(Number(value)));
}

/** Prozentsatz mit zwei Nachkommastellen (`19,00`). */
export function formatRate(rate: number): string {
  return formatAmount(Math.round(rate * 100));
}

const berlinFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TSE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/**
 * Ortszeit Berlin mit Versatz nach RFC 3339, sekundengenau:
 * `2026-11-03T18:41:04+01:00`.
 */
export function rfc3339Berlin(date: Date): string {
  const parts: Record<string, string> = {};
  for (const part of berlinFormatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const local = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const seconds = Math.floor(date.getTime() / 1000) * 1000;
  const offsetMinutes = Math.round((local - seconds) / 60_000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}${offset}`;
}

/** TSE-Log-Zeit: `2026-11-03T15:06:36.000Z` (UTC, Millisekunden). */
export function isoUtcMillis(date: Date): string {
  return date.toISOString();
}

/** Text fuer eine Zeichen-Spalte: ohne Zeilenumbrueche, auf Laenge gekuerzt. */
export function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value)
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  return [...text].slice(0, maxLength).join('');
}

/**
 * Baut eine Zeile aus einem Objekt Spaltenname → Wert. Unbekannte Spalten
 * sind ein Programmierfehler (wirft), fehlende bleiben leer. Zeichenwerte
 * werden gekuerzt; Zahlen muessen bereits formatiert sein.
 */
export function makeRow(
  table: TableName,
  values: Record<string, string | null | undefined>,
): CsvRow {
  const def = TABLE_BY_NAME[table];
  const known = new Set(def.columns.map((c) => c.name));
  for (const key of Object.keys(values)) {
    if (!known.has(key)) {
      throw new Error(`DSFinV-K: unknown column ${key} in ${table}`);
    }
  }
  return def.columns.map((column) => {
    const raw = values[column.name];
    if (raw === null || raw === undefined) return '';
    if (column.type === 'alpha') {
      // TSE_VORGANGSDATEN darf Zeilentrenner (CR) der Bestellung enthalten.
      if (column.name === 'TSE_VORGANGSDATEN') return raw;
      return cleanText(raw, column.maxLength ?? 255);
    }
    return raw;
  });
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** CSV einer Tabelle: Kopfzeile + Zeilen, Zeichen-Spalten in `"`. */
export function encodeTable(table: TableName, rows: CsvRow[]): string {
  const def = TABLE_BY_NAME[table];
  const lines = [def.columns.map((c) => c.name).join(CSV_DELIMITER)];
  for (const row of rows) {
    lines.push(
      def.columns
        .map((column, index) => {
          const value = row[index] ?? '';
          return column.type === 'alpha' ? quote(value) : value;
        })
        .join(CSV_DELIMITER),
    );
  }
  return lines.join(CSV_RECORD_DELIMITER) + CSV_RECORD_DELIMITER;
}

/**
 * Liest eine DSFinV-K-CSV (fuer die eigene Pruefung). Beachtet `"`-Begrenzer
 * mit verdoppelten Anfuehrungszeichen und Zeilenumbrueche innerhalb von
 * Begrenzern. Liefert Zeilen inkl. Kopfzeile und je Feld, ob es begrenzt war.
 */
export interface ParsedCsv {
  records: { values: string[]; quoted: boolean[]; line: number }[];
  /** Datensatztrenner, die nicht CR LF waren (Zeilennummern). */
  badRecordDelimiters: number[];
  unterminatedQuote: boolean;
}

export function parseCsv(text: string): ParsedCsv {
  const records: ParsedCsv['records'] = [];
  const badRecordDelimiters: number[] = [];
  let values: string[] = [];
  let quoted: boolean[] = [];
  let field = '';
  let fieldQuoted = false;
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let i = 0;
  const pushField = () => {
    values.push(field);
    quoted.push(fieldQuoted);
    field = '';
    fieldQuoted = false;
  };
  const pushRecord = () => {
    pushField();
    records.push({ values, quoted, line: recordLine });
    values = [];
    quoted = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      if (ch === '\n') line++;
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '' && !fieldQuoted) {
      inQuotes = true;
      fieldQuoted = true;
      i++;
      continue;
    }
    if (ch === ';') {
      pushField();
      i++;
      continue;
    }
    if (ch === '\r' && text[i + 1] === '\n') {
      pushRecord();
      i += 2;
      line++;
      recordLine = line;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      badRecordDelimiters.push(line);
      pushRecord();
      i++;
      line++;
      recordLine = line;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== '' || fieldQuoted || values.length > 0) pushRecord();
  return { records, badRecordDelimiters, unterminatedQuote: inQuotes };
}
