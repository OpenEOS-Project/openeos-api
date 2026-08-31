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

/** Obergrenze eines Bereichs: reines Datum wird auf 23:59:59.999 gedehnt. */
export function endOfDay(value: string | Date): Date {
  if (value instanceof Date) return value;
  const date = new Date(value);
  if (isPlainDate(value)) {
    date.setHours(23, 59, 59, 999);
  }
  return date;
}

/** Untergrenze eines Bereichs. Reines Datum heißt Tagesbeginn — das ist
 *  bereits das Verhalten von new Date(), hier nur der Symmetrie halber. */
export function startOfDay(value: string | Date): Date {
  if (value instanceof Date) return value;
  const date = new Date(value);
  if (isPlainDate(value)) {
    date.setHours(0, 0, 0, 0);
  }
  return date;
}
