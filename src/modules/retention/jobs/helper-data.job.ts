import { daysBefore } from '../retention.config';
import { affected } from '../retention-sql';
import type { RetentionJob, RetentionRunContext } from '../retention.types';

/**
 * Schichtanmeldungen von Helfern (Name, E-Mail, Telefon, Anmerkungen,
 * Notizen, Verwaltungslinks): `RETENTION_HELPER_DATA_DAYS` (30) Tage nach
 * der letzten Schicht des Schichtplans werden die Anmeldungen samt
 * Aenderungsvorschlaegen und Helfer-Links geloescht. Der Plan mit seinen
 * Schichten bleibt (z. B. als Vorlage).
 */
export class HelperDataJob implements RetentionJob {
  readonly category = 'helper_data' as const;

  async run(ctx: RetentionRunContext): Promise<void> {
    const cutoff = daysBefore(ctx.now, ctx.config.helperDataDays);
    const { manager } = ctx;

    // Letzter Schichttag + 1 (Schichten ueber Mitternacht) vor der Grenze.
    const plans = `SELECT sj.shift_plan_id FROM shift_jobs sj
        JOIN shifts s ON s.shift_job_id = sj.id
       GROUP BY sj.shift_plan_id
      HAVING max(s.date) + 1 < ($1::timestamptz AT TIME ZONE 'Europe/Berlin')::date`;

    ctx.removed(
      'registrationsDeleted',
      await affected(
        manager,
        `DELETE FROM shift_registrations r
          WHERE r.shift_id IN (SELECT s.id FROM shifts s
                                 JOIN shift_jobs sj ON sj.id = s.shift_job_id
                                WHERE sj.shift_plan_id IN (${plans}))`,
        [cutoff],
      ),
    );
    ctx.removed(
      'changeProposalsDeleted',
      await affected(
        manager,
        `DELETE FROM shift_change_proposals p WHERE p.shift_plan_id IN (${plans})`,
        [cutoff],
      ),
    );
    ctx.removed(
      'helperLinksDeleted',
      await affected(
        manager,
        `DELETE FROM helper_magic_links l WHERE l.shift_plan_id IN (${plans})`,
        [cutoff],
      ),
    );
  }
}
