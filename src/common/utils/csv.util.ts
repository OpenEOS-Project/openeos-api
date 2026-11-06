/**
 * CSV fuer Excel in Deutschland — dieselben Regeln wie der CSV-Export der
 * Berichte in der Verwaltung (openeos-web `reports/components/csv-export.ts`):
 *
 * - Trennzeichen Semikolon, Zeilenende CRLF
 * - UTF-8 mit BOM, sonst zeigt Excel Umlaute falsch an
 * - Felder mit `;`, `"` oder Zeilenumbruch in Anfuehrungszeichen, `"`
 *   verdoppelt
 * - Zahlen mit Dezimalkomma und ohne Tausenderpunkt (`1234,50`), damit
 *   Excel sie als Zahl liest
 *
 * Dazu kommt Schutz vor Formel-Einschleusung: Texte, die mit `=`, `+`,
 * `-`, `@`, Tab oder CR beginnen (etwa ein Gastname `=HYPERLINK(…)`),
 * bekommen ein fuehrendes Hochkomma. Zahlen laufen nicht durch `csvText`,
 * negative Betraege bleiben also Zahlen.
 */

export const CSV_SEPARATOR = ';';
export const CSV_LINE_END = '\r\n';
/** Byte Order Mark — kennzeichnet die Datei fuer Excel als UTF-8. */
export const CSV_BOM = '\uFEFF';

const NEEDS_QUOTES = /[;"\r\n]/;
const FORMULA_START = /^[=+\-@\t\r]/;

/** Text als CSV-Feld (maskiert, gegen Formeln geschuetzt). */
export function csvText(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Zahl mit Dezimalkomma. `digits` feste Nachkommastellen (Betraege: 2);
 * ohne `digits` so viele wie noetig (Steuersatz 19 → `19`, 10,7 → `10,7`).
 */
export function csvNumber(
  value: number | string | null | undefined,
  digits?: number,
): string {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  const text =
    digits === undefined
      ? String(Math.round(number * 100) / 100)
      : number.toFixed(digits);
  // -0,00 sieht in Excel wie ein Fehler aus.
  const clean = /^-0(\.0+)?$/.test(text) ? text.slice(1) : text;
  return clean.replace('.', ',');
}

/** Geldbetrag mit zwei Nachkommastellen (`12,50`). */
export function csvMoney(value: number | string | null | undefined): string {
  return csvNumber(value, 2);
}

/** Eine Zeile aus bereits formatierten Feldern, mit Zeilenende. */
export function csvLine(cells: readonly string[]): string {
  return cells.join(CSV_SEPARATOR) + CSV_LINE_END;
}

/** Kopfzeile: Spaltennamen als Text. */
export function csvHeader(columns: readonly string[]): string {
  return csvLine(columns.map((c) => csvText(c)));
}
