import type { EntityManager } from 'typeorm';
import { rowsOf } from '../tse/tse-sql.util';

/**
 * Bedienungen stilllegen, anonymisieren und loeschen (bedienungen-plan.md
 * §10). Gemeinsam fuer „Löschen“ in der Verwaltung, das Loeschen einer
 * Veranstaltung, den Loeschlauf `waiter_data` und das Loeschen einer
 * Organisation — ohne Dienste, nur mit dem EntityManager der Transaktion.
 *
 * Das Steuerarchiv bleibt unberuehrt: `tse_transactions.operator_name`
 * (BEDIENER_NAME der DSFinV-K), Kassenabschluesse und Kassenbuch-Belege
 * behalten den Namen beim Signieren zehn Jahre.
 */

/** Steht die Bedienung in irgendeiner Buchung (oder Abrechnung)? */
export async function waiterHasBookings(
  manager: EntityManager,
  waiterId: string,
): Promise<boolean> {
  const [row] = rowsOf<{ used: boolean }>(
    await manager.query(
      `SELECT (
         EXISTS (SELECT 1 FROM orders WHERE created_by_waiter_id = $1 OR waiter_id = $1)
         OR EXISTS (SELECT 1 FROM order_items WHERE added_by_waiter_id = $1)
         OR EXISTS (SELECT 1 FROM payments WHERE processed_by_waiter_id = $1 OR wallet_waiter_id = $1)
         OR EXISTS (SELECT 1 FROM refunds WHERE waiter_id = $1 OR approved_by_waiter_id = $1)
         OR EXISTS (SELECT 1 FROM pfand_returns WHERE waiter_id = $1)
         OR EXISTS (SELECT 1 FROM order_events WHERE waiter_id = $1)
         OR EXISTS (SELECT 1 FROM cashbook_entries WHERE waiter_id = $1)
         OR EXISTS (SELECT 1 FROM tse_transactions WHERE waiter_id = $1)
         OR EXISTS (SELECT 1 FROM waiter_settlements WHERE waiter_id = $1 OR settled_by_waiter_id = $1)
       ) AS used`,
      [waiterId],
    ),
  );
  return row?.used === true;
}

/** PIN weg, offene Sitzungen beendet (das Geraet sperrt). */
export async function revokeWaiterAccess(
  manager: EntityManager,
  waiterIds: string[],
): Promise<void> {
  if (!waiterIds.length) return;
  await manager.query(
    `UPDATE waiter_sessions SET ended_at = now(), end_reason = 'revoked', updated_at = now()
      WHERE ended_at IS NULL AND waiter_id = ANY($1::uuid[])`,
    [waiterIds],
  );
  await manager.query(
    `DELETE FROM pin_credentials WHERE owner_type = 'waiter' AND owner_id = ANY($1::uuid[])`,
    [waiterIds],
  );
}

/**
 * Anonymisieren: Name → „Bedienung N“, Kurzname, Farbe und Verknuepfungen
 * leer, deaktiviert, PIN weg. Die Namen in Storno-/Erstattungsprotokollen
 * (`order_events.actor_name`, `refunds.actor_name`) werden durch dasselbe
 * Pseudonym ersetzt. Liefert das Pseudonym (oder null, wenn die Bedienung
 * schon anonymisiert bzw. nicht vorhanden ist).
 */
export async function anonymizeWaiter(
  manager: EntityManager,
  waiterId: string,
  now: Date = new Date(),
): Promise<string | null> {
  const [waiter] = rowsOf<{
    organization_id: string;
    anonymized_at: Date | null;
  }>(
    await manager.query(
      `SELECT organization_id, anonymized_at FROM waiters WHERE id = $1 FOR UPDATE`,
      [waiterId],
    ),
  );
  if (!waiter || waiter.anonymized_at) return null;
  await revokeWaiterAccess(manager, [waiterId]);
  const [{ n }] = rowsOf<{ n: number }>(
    await manager.query(
      `SELECT count(*)::int + 1 AS n FROM waiters
        WHERE organization_id = $1 AND anonymized_at IS NOT NULL`,
      [waiter.organization_id],
    ),
  );
  const pseudonym = `Bedienung ${n}`;
  await manager.query(
    `UPDATE waiters
        SET name = $2, short_name = NULL, color = NULL, user_id = NULL,
            source_registration_group_id = NULL, is_active = false,
            deactivated_at = COALESCE(deactivated_at, $3),
            anonymized_at = $3, updated_at = now()
      WHERE id = $1`,
    [waiterId, pseudonym, now],
  );
  await manager.query(
    `UPDATE order_events SET actor_name = $2 WHERE waiter_id = $1 AND actor_name IS DISTINCT FROM $2`,
    [waiterId, pseudonym],
  );
  await manager.query(
    `UPDATE refunds SET actor_name = $2 WHERE waiter_id = $1 AND actor_name IS DISTINCT FROM $2`,
    [waiterId, pseudonym],
  );
  return pseudonym;
}

export type RetireOutcome = 'deleted' | 'anonymized' | 'unchanged';

/**
 * Ohne Buchungen loeschen (Sitzungen haengen per CASCADE dran), sonst
 * anonymisieren.
 */
export async function retireWaiter(
  manager: EntityManager,
  waiterId: string,
  now: Date = new Date(),
): Promise<RetireOutcome> {
  if (!(await waiterHasBookings(manager, waiterId))) {
    await revokeWaiterAccess(manager, [waiterId]);
    await manager.query(`DELETE FROM waiters WHERE id = $1`, [waiterId]);
    return 'deleted';
  }
  return (await anonymizeWaiter(manager, waiterId, now))
    ? 'anonymized'
    : 'unchanged';
}

/**
 * Veranstaltung geloescht (Papierkorb): ihre Bedienungen koennen sich
 * nicht mehr anmelden. Ohne Buchungen werden sie geloescht; mit Buchungen
 * bleiben sie deaktiviert stehen (die Zuordnung in Zahlungen und
 * Erstattungen bleibt) und der Loeschlauf anonymisiert sie nach der Frist.
 */
export async function retireEventWaiters(
  manager: EntityManager,
  organizationId: string,
  eventId: string,
  now: Date = new Date(),
): Promise<{ waiterIds: string[]; deleted: number; deactivated: number }> {
  const waiters = rowsOf<{ id: string }>(
    await manager.query(
      `SELECT id FROM waiters WHERE organization_id = $1 AND event_id = $2 AND anonymized_at IS NULL`,
      [organizationId, eventId],
    ),
  );
  const ids = waiters.map((w) => w.id);
  await revokeWaiterAccess(manager, ids);
  let deleted = 0;
  for (const id of ids) {
    if (!(await waiterHasBookings(manager, id))) {
      await manager.query(`DELETE FROM waiters WHERE id = $1`, [id]);
      deleted++;
    }
  }
  const deactivated = rowsOf<{ id: string }>(
    await manager.query(
      `UPDATE waiters SET is_active = false,
              deactivated_at = COALESCE(deactivated_at, $3), updated_at = now()
        WHERE organization_id = $1 AND event_id = $2 AND anonymized_at IS NULL
        RETURNING id`,
      [organizationId, eventId, now],
    ),
  ).length;
  return { waiterIds: ids, deleted, deactivated };
}
