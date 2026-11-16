import { monthsBefore } from '../retention.config';
import { affected } from '../retention-sql';
import type { RetentionJob, RetentionRunContext } from '../retention.types';

/**
 * Meldungen ueber „Inhalt melden“ (Art. 16/17 DSA):
 * `RETENTION_CONTENT_REPORT_MONTHS` (12) Monate nach dem Abschluss der
 * Pruefung (`closed_at`). Offene und laufende Meldungen bleiben, bis sie
 * abgeschlossen sind.
 */
export class ContentReportsJob implements RetentionJob {
  readonly category = 'content_reports' as const;

  async run(ctx: RetentionRunContext): Promise<void> {
    const cutoff = monthsBefore(ctx.now, ctx.config.contentReportMonths);
    ctx.removed(
      'reportsDeleted',
      await affected(
        ctx.manager,
        `DELETE FROM content_reports
          WHERE status = 'closed' AND closed_at IS NOT NULL AND closed_at < $1`,
        [cutoff],
      ),
    );
  }
}
