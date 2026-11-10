import type { EntityManager } from 'typeorm';
import { rowsOf } from '../tse/tse-sql.util';

/**
 * Fuehrt ein UPDATE/DELETE aus und liefert die Anzahl betroffener Zeilen.
 *
 * Die Anweisung wird in ein `WITH … RETURNING 1` gewickelt, damit die
 * Anzahl unabhaengig davon ankommt, wie der Treiber UPDATE/DELETE meldet.
 * Die Anweisung selbst darf deshalb kein eigenes `WITH` und kein
 * `RETURNING` enthalten.
 */
export async function affected(
  manager: EntityManager,
  statement: string,
  params: unknown[] = [],
): Promise<number> {
  const rows = rowsOf<{ n: number }>(
    await manager.query(
      `WITH affected AS (${statement} RETURNING 1)
       SELECT count(*)::int AS n FROM affected`,
      params,
    ),
  );
  return rows[0]?.n ?? 0;
}

export async function select<T>(
  manager: EntityManager,
  statement: string,
  params: unknown[] = [],
): Promise<T[]> {
  return rowsOf<T>(await manager.query(statement, params));
}

/**
 * Letzte Nutzung einer Organisation (`o` im umgebenden FROM): Anlage,
 * letzte Veranstaltung (Anlage, Ende, Bezahlung), letzte Bestellung, ein
 * „Behalten“ durch den Super-Admin und das Wiederherstellen nach dem
 * Loeschen („Löschung abbrechen“). Bewusst grosszuegig — im Zweifel
 * gilt eine Organisation als genutzt und wird nicht angekuendigt.
 */
export const ORGANIZATION_ACTIVITY_SQL = `GREATEST(
    o.created_at,
    COALESCE((SELECT max(GREATEST(e.created_at, COALESCE(e.end_date, e.created_at), COALESCE(e.paid_at, e.created_at)))
                FROM events e WHERE e.organization_id = o.id), o.created_at),
    COALESCE((SELECT max(ord.created_at) FROM orders ord WHERE ord.organization_id = o.id), o.created_at),
    COALESCE((SELECT max(n.cancelled_at) FROM retention_notices n
               WHERE n.subject_type = 'organization' AND n.subject_id = o.id
                 AND n.cancel_reason IN ('kept', 'restored')), o.created_at)
  )`;

/**
 * Letzte Nutzung eines Benutzerkontos (`u` im umgebenden FROM): Anlage,
 * letzte Anmeldung, Loeschung einer seiner Organisationen und ein
 * „Behalten“ durch den Super-Admin.
 */
export const USER_ACTIVITY_SQL = `GREATEST(
    u.created_at,
    COALESCE(u.last_login_at, u.created_at),
    COALESCE((SELECT max(org.deleted_at) FROM user_organizations uo
                JOIN organizations org ON org.id = uo.organization_id
               WHERE uo.user_id = u.id), u.created_at),
    COALESCE((SELECT max(n.cancelled_at) FROM retention_notices n
               WHERE n.subject_type = 'user' AND n.subject_id = u.id
                 AND n.cancel_reason = 'kept'), u.created_at)
  )`;

/**
 * Bestellungen einer Organisation ($1), auf die das Steuerarchiv verweist
 * (TSE-Vorgaenge, Bewirtungsbelege).
 */
export const FISCAL_ORDER_IDS_SQL = `
  SELECT t.order_id FROM tse_transactions t
   WHERE t.organization_id = $1 AND t.order_id IS NOT NULL
  UNION
  SELECT p.order_id FROM payments p
    JOIN tse_transactions t ON t.payment_id = p.id
   WHERE t.organization_id = $1
  UNION
  SELECT r.order_id FROM refunds r
    JOIN tse_transactions t ON t.refund_id = r.id
   WHERE t.organization_id = $1
  UNION
  SELECT h.order_id FROM hospitality_receipt_orders h
    JOIN hospitality_receipts hr ON hr.id = h.hospitality_receipt_id
   WHERE h.organization_id = $1 AND NOT hr.is_test`;
