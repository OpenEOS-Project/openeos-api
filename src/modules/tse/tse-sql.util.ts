/**
 * `Repository.query()` liefert bei Postgres fuer SELECT/INSERT die Zeilen,
 * fuer UPDATE/DELETE aber `[zeilen, anzahl]`. Diese Hilfe gibt in beiden
 * Faellen die Zeilen zurueck (z. B. bei `UPDATE … RETURNING`).
 */
export function rowsOf<T>(raw: unknown): T[] {
  if (
    Array.isArray(raw) &&
    raw.length === 2 &&
    Array.isArray(raw[0]) &&
    typeof raw[1] === 'number'
  ) {
    return raw[0] as T[];
  }
  return Array.isArray(raw) ? (raw as T[]) : [];
}
