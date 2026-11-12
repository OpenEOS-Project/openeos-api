/**
 * How TypeORM treats `null` and `undefined` in find/update/delete criteria.
 *
 * TypeORM's default silently drops such properties from the WHERE clause,
 * so `{ id, eventId: undefined }` matched rows of any event. Both now raise
 * an error instead: a missing value must be handled in code, and a real
 * SQL `IS NULL` is written as `IsNull()`.
 *
 * Used by the application DataSource, the CLI DataSource and the
 * Postgres specs, so they all behave the same.
 */
export const INVALID_WHERE_VALUES_BEHAVIOR = {
  null: 'throw',
  undefined: 'throw',
} as const;
