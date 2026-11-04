import { monthsBefore } from '../retention.config';
import { ORGANIZATION_ACTIVITY_SQL, affected } from '../retention-sql';
import type { RetentionJob, RetentionRunContext } from '../retention.types';

/**
 * Support-Chat einer Organisation: fuer die Dauer der Nutzung und danach
 * `RETENTION_SUPPORT_MONTHS` (12) Monate. Geloescht wird der ganze Verlauf
 * einer Organisation, wenn sowohl die letzte Nachricht als auch die letzte
 * Nutzung (bzw. die Loeschung der Organisation) so lange zurueckliegen.
 */
export class SupportMessagesJob implements RetentionJob {
  readonly category = 'support_messages' as const;

  async run(ctx: RetentionRunContext): Promise<void> {
    const cutoff = monthsBefore(ctx.now, ctx.config.supportMonths);
    ctx.removed(
      'messagesDeleted',
      await affected(
        ctx.manager,
        `DELETE FROM support_messages sm
          WHERE sm.organization_id IN (
            SELECT o.id FROM organizations o
             WHERE GREATEST(${ORGANIZATION_ACTIVITY_SQL}, COALESCE(o.deleted_at, o.created_at)) < $1
               AND NOT EXISTS (SELECT 1 FROM support_messages m
                                WHERE m.organization_id = o.id AND m.created_at >= $1))`,
        [cutoff],
      ),
    );
  }
}
