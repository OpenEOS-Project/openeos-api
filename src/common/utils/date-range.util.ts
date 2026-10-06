/**
 * Datumsbereiche aus Abfrageparametern.
 *
 * Die Berichte filtern mit `createdAt BETWEEN :startDate AND :endDate`.
 * Wird ein reines Datum übergeben, liest `new Date('2026-08-31')` das
 * als 2026-08-31T00:00:00Z — Mitternacht. Bei Start gleich Ende umfasst
 * der Bereich damit exakt eine Millisekunde, und jede Bestellung des
 * Tages fällt heraus.
 *
 * Genau das ist im Dashboard passiert: die Widgets fragen „heute" mit
 * startDate = endDate = heute ab und bekamen immer null zurück.
 *
 * `endOfDay` dehnt ein reines Datum auf das Tagesende. Enthält der Wert
 * bereits eine Uhrzeit, bleibt er unangetastet — dann hat der Aufrufer
 * den Zeitpunkt bewusst gewählt.
 */

/** true, wenn der Wert ein reines Datum ohne Uhrzeit ist (YYYY-MM-DD). */
function isPlainDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

/**
 * Reines Datum als lokaler Zeitpunkt (Zone des Prozesses, im Image
 * TZ=Europe/Berlin). Bewusst aus den Ziffern gebaut und nicht ueber
 * `new Date('2026-08-31')`: das ist Mitternacht UTC, in Berlin also schon
 * 02:00 Uhr (Sommerzeit) — Bestellungen zwischen Mitternacht und 2 Uhr
 * fielen aus "heute" heraus und zaehlten zum Vortag.
 */
function localTime(
  value: string,
  h: number,
  m: number,
  s: number,
  ms: number,
): Date {
  const [year, month, day] = value.trim().split('-').map(Number);
  return new Date(year, month - 1, day, h, m, s, ms);
}

/** Obergrenze eines Bereichs: reines Datum wird auf 23:59:59.999 gedehnt. */
export function endOfDay(value: string | Date): Date {
  if (value instanceof Date) return value;
  return isPlainDate(value)
    ? localTime(value, 23, 59, 59, 999)
    : new Date(value);
}

/** Untergrenze eines Bereichs: reines Datum heißt lokaler Tagesbeginn. */
export function startOfDay(value: string | Date): Date {
  if (value instanceof Date) return value;
  return isPlainDate(value) ? localTime(value, 0, 0, 0, 0) : new Date(value);
}

/**
 * Kalendertag eines Zeitpunkts in der Zone des Prozesses ('YYYY-MM-DD').
 * Ersetzt `toISOString().split('T')[0]`, das den UTC-Tag liefert und in
 * Berlin zwischen Mitternacht und 2 Uhr noch den Vortag.
 */
export function localDateKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
