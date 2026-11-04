import { monthsBefore } from '../retention.config';
import { affected } from '../retention-sql';
import type { RetentionJob, RetentionRunContext } from '../retention.types';

/**
 * Anfragen ueber Kontakt- und Rueckmeldeformular der Website:
 * `RETENTION_CONTACT_MONTHS` (6) Monate nach Abschluss der Bearbeitung
 * („erledigt“). Unerledigte Anfragen bleiben, bis sie erledigt sind.
 */
export class ContactRequestsJob implements RetentionJob {
  readonly category = 'contact_requests' as const;

  async run(ctx: RetentionRunContext): Promise<void> {
    const cutoff = monthsBefore(ctx.now, ctx.config.contactMonths);
    ctx.removed(
      'requestsDeleted',
      await affected(
        ctx.manager,
        `DELETE FROM contact_requests
          WHERE handled_at IS NOT NULL AND handled_at < $1`,
        [cutoff],
      ),
    );
  }
}
