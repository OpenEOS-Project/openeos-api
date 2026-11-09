import {
  anonymizeWaiter,
  waiterHasBookings,
} from '../../waiters/waiter-retire';
import { daysBefore, monthsBefore } from '../retention.config';
import { affected, select } from '../retention-sql';
import type { RetentionJob, RetentionRunContext } from '../retention.types';

/**
 * Bedienungen (Kassenprofile ohne Konto), bedienungen-plan.md §10:
 *
 * - veranstaltungsgebunden: `RETENTION_WAITER_DATA_DAYS` (30) Tage nach dem
 *   Ende der Veranstaltung (bzw. nach ihrer Loeschung)
 * - organisationsweit: dieselbe Frist nach der Deaktivierung oder
 *   `RETENTION_WAITER_INACTIVE_MONTHS` (12) Monate ohne Anmeldung
 *
 * Ohne Buchungen wird die Bedienung geloescht, sonst anonymisiert (Name →
 * „Bedienung N“, Kurzname/Farbe/Verknuepfungen leer, PIN weg) und ihr Name
 * in Storno-/Erstattungsprotokollen pseudonymisiert. Das Steuerarchiv
 * (`tse_transactions.operator_name`, Kassenabschluesse, Kassenbuch) bleibt.
 * Sitzungen (Anmeldungen an Geraeten) werden nach
 * `RETENTION_WAITER_SESSION_DAYS` (90) Tagen geloescht. Im Probelauf rollt
 * der Lauf alles zurueck (nur Zaehlen).
 */
export class WaiterDataJob implements RetentionJob {
  readonly category = 'waiter_data' as const;

  async run(ctx: RetentionRunContext): Promise<void> {
    const { manager, config, now } = ctx;
    const cutoff = daysBefore(now, config.waiterDataDays);
    const idleCutoff = monthsBefore(now, config.waiterInactiveMonths);

    const due = await select<{ id: string; reason: string }>(
      manager,
      `SELECT w.id,
              CASE WHEN w.event_id IS NOT NULL THEN 'dueEventEnded'
                   WHEN NOT w.is_active AND w.deactivated_at < $1 THEN 'dueDeactivated'
                   ELSE 'dueUnused' END AS reason
         FROM waiters w
         LEFT JOIN events e ON e.id = w.event_id
        WHERE w.anonymized_at IS NULL
          AND (
            (w.event_id IS NOT NULL
               AND (e.id IS NULL OR LEAST(e.end_date, e.deleted_at) < $1))
            OR (w.event_id IS NULL AND NOT w.is_active AND w.deactivated_at < $1)
            OR (w.event_id IS NULL AND COALESCE(w.last_used_at, w.created_at) < $2)
          )
        ORDER BY w.organization_id, w.created_at`,
      [cutoff, idleCutoff],
    );

    let deleted = 0;
    let anonymised = 0;
    for (const waiter of due) {
      if (!(await waiterHasBookings(manager, waiter.id))) {
        await manager.query(
          `DELETE FROM pin_credentials WHERE owner_type = 'waiter' AND owner_id = $1`,
          [waiter.id],
        );
        await manager.query(`DELETE FROM waiters WHERE id = $1`, [waiter.id]);
        deleted++;
      } else if (await anonymizeWaiter(manager, waiter.id, now)) {
        anonymised++;
      }
      ctx.note(waiter.reason, 1);
    }
    ctx.removed('waitersDeleted', deleted);
    ctx.removed('waitersAnonymised', anonymised);

    ctx.removed(
      'sessionsDeleted',
      await affected(
        manager,
        `DELETE FROM waiter_sessions
          WHERE COALESCE(ended_at, last_seen_at) < $1`,
        [daysBefore(now, config.waiterSessionDays)],
      ),
    );
  }
}
