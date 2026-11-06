import type { EntityManager } from 'typeorm';

import { affected } from './retention-sql';

/** Endgueltig geloescht (nur noch Huelle mit Steuerarchiv)? `o` im FROM. */
export const ORGANIZATION_PURGED_SQL = `(o.slug LIKE 'purged-%' OR EXISTS (
   SELECT 1 FROM retention_notices x
    WHERE x.subject_type = 'organization' AND x.subject_id = o.id
      AND x.kind = 'organization_deletion' AND x.executed_at IS NOT NULL))`;

/**
 * „Löschung abbrechen“: holt eine geloeschte bzw. geschlossene, aber noch
 * nicht endgueltig geloeschte Organisation zurueck. Die Ankuendigung der
 * endgueltigen Loeschung verfaellt (`restored`); der Zeitpunkt zaehlt als
 * Nutzung (`ORGANIZATION_ACTIVITY_SQL`), damit sie nicht gleich wieder
 * wegen Inaktivitaet angekuendigt wird. Liefert `false`, wenn es nichts
 * wiederherzustellen gab.
 */
export async function restoreOrganization(
  manager: EntityManager,
  organizationId: string,
  now: Date,
): Promise<boolean> {
  const restored = await affected(
    manager,
    `UPDATE organizations o SET deleted_at = NULL
      WHERE o.id = $1 AND o.deleted_at IS NOT NULL
        AND NOT ${ORGANIZATION_PURGED_SQL}`,
    [organizationId],
  );
  if (restored === 0) return false;
  const cancelled = await affected(
    manager,
    `UPDATE retention_notices SET cancelled_at = $2, cancel_reason = 'restored'
      WHERE subject_type = 'organization' AND subject_id = $1
        AND kind = 'organization_deletion'
        AND executed_at IS NULL AND cancelled_at IS NULL`,
    [organizationId, now],
  );
  if (cancelled === 0) {
    // Noch nicht angekuendigt: trotzdem festhalten, dass (und wann)
    // wiederhergestellt wurde.
    await manager.query(
      `INSERT INTO retention_notices
         (subject_type, subject_id, kind, sent_at, recipient_count, due_at,
          cancelled_at, cancel_reason)
       VALUES ('organization', $1, 'organization_deletion', $2, 0, $2, $2, 'restored')`,
      [organizationId, now],
    );
  }
  return true;
}
