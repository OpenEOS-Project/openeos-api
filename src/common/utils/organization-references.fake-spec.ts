/**
 * Nachbau der Abfragen aus organization-references.ts fuer Unit-Tests:
 * Zeilen je Tabelle, Organisation direkt oder ueber Veranstaltung bzw.
 * Bestellung. Nur fuer Specs (der Dateiname haelt sie aus dem Build).
 */
export interface ReferenceRow {
  id: string;
  organization_id?: string;
  event_id?: string;
  order_id?: string;
  deleted_at?: Date | null;
}

export type ReferenceTables = Record<string, ReferenceRow[]>;

export function fakeReferenceDb(tables: ReferenceTables) {
  const find = (table: string, id: string | undefined) =>
    (tables[table] ?? []).find((row) => row.id === id);
  const ownerOf = (row: ReferenceRow): string | undefined =>
    row.organization_id ??
    (row.event_id
      ? find('events', row.event_id)?.organization_id
      : undefined) ??
    (row.order_id ? find('orders', row.order_id)?.organization_id : undefined);

  const query = jest.fn((sql: string, params: unknown[] = []) => {
    const table = /FROM (\w+) t\b/.exec(sql)?.[1];
    if (!table) return Promise.resolve([]);
    const [ids, organizationId, parent] = params as [
      string[],
      string,
      string | undefined,
    ];
    const wanted = new Set(ids.map((id) => id.toLowerCase()));
    const aliveOnly = sql.includes('deleted_at IS NULL');
    return Promise.resolve(
      (tables[table] ?? [])
        .filter(
          (row) =>
            wanted.has(row.id.toLowerCase()) &&
            ownerOf(row) === organizationId &&
            (parent === undefined ||
              row.event_id === parent ||
              row.order_id === parent) &&
            (!aliveOnly || !row.deleted_at),
        )
        .map((row) => ({ id: row.id })),
    );
  });
  return { query };
}
