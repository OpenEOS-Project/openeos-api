import {
  daysAfter,
  exportOfferHonoured,
  monthsBefore,
} from '../retention.config';
import { organizationInactivityMail } from '../retention-mails';
import type { RetentionNoticeService } from '../retention-notice.service';
import { ORGANIZATION_ACTIVITY_SQL, affected, select } from '../retention-sql';
import type { RetentionJob, RetentionRunContext } from '../retention.types';

/**
 * Kundenkonten ohne Buchung: nach `RETENTION_INACTIVE_ORG_MONTHS` (24)
 * Monaten ohne Nutzung bekommen die Administratoren eine Ankuendigung mit
 * Exportlink; fruehestens `RETENTION_NOTICE_DAYS` (30) Tage spaeter wird die
 * Organisation geschlossen (wie „Organisation loeschen“). Ab dann gilt die
 * Exportfrist und die endgueltige Loeschung (organization_purge).
 *
 * Wird die Organisation zwischenzeitlich genutzt, verfaellt die
 * Ankuendigung. Organisationen mit aktiver Cloud-TSE werden nie
 * automatisch geschlossen.
 */
export class OrganizationInactivityJob implements RetentionJob {
  readonly category = 'organization_inactivity' as const;

  constructor(private readonly notices: RetentionNoticeService) {}

  async run(ctx: RetentionRunContext): Promise<void> {
    const { manager, now, config } = ctx;
    const cutoff = monthsBefore(now, config.inactiveOrganizationMonths);

    // 1. Offene Ankuendigungen pruefen: genutzt, geloescht oder faellig?
    const open = await select<{
      id: string;
      subject_id: string;
      sent_at: Date;
      due_at: Date;
      activity_at: Date | null;
      activity: Date;
      deleted_at: Date | null;
      tse_live: boolean;
    }>(
      manager,
      `SELECT n.id, n.subject_id, n.sent_at, n.due_at, n.activity_at,
              ${ORGANIZATION_ACTIVITY_SQL} AS activity, o.deleted_at,
              EXISTS (SELECT 1 FROM tse_units tu WHERE tu.organization_id = o.id
                        AND tu.state IN ('creating', 'active')) AS tse_live
         FROM retention_notices n
         JOIN organizations o ON o.id = n.subject_id
        WHERE n.subject_type = 'organization' AND n.kind = 'organization_inactivity'
          AND n.executed_at IS NULL AND n.cancelled_at IS NULL`,
    );
    const pending = new Set<string>();
    for (const notice of open) {
      pending.add(notice.subject_id);
      if (notice.deleted_at) {
        await this.notices.cancel(manager, notice.id, now, 'deleted');
        ctx.note('noticesCancelledDeleted', 1);
        continue;
      }
      if (
        new Date(notice.activity).getTime() >
        new Date(notice.activity_at ?? notice.sent_at).getTime()
      ) {
        await this.notices.cancel(manager, notice.id, now, 'activity');
        ctx.note('noticesCancelledActivity', 1);
        continue;
      }
      if (
        new Date(notice.due_at) > now ||
        !exportOfferHonoured(new Date(notice.sent_at), now, config.noticeDays)
      ) {
        ctx.note('noticesWaiting', 1);
        continue;
      }
      if (notice.tse_live) {
        ctx.note('skippedTseActive', 1);
        continue;
      }
      await affected(
        manager,
        `UPDATE organizations SET deleted_at = $2
          WHERE id = $1 AND deleted_at IS NULL`,
        [notice.subject_id, now],
      );
      await this.notices.markExecuted(manager, notice.id, now);
      ctx.removed('organizationsClosed', 1);
    }

    // 2. Neue Kandidaten ankuendigen.
    const candidates = await select<{
      id: string;
      name: string;
      activity: Date;
    }>(
      manager,
      `SELECT o.id, o.name, ${ORGANIZATION_ACTIVITY_SQL} AS activity
         FROM organizations o
        WHERE o.deleted_at IS NULL AND ${ORGANIZATION_ACTIVITY_SQL} < $1`,
      [cutoff],
    );
    for (const candidate of candidates) {
      if (pending.has(candidate.id)) continue;
      if (ctx.dryRun) {
        ctx.note('noticesDue', 1);
        continue;
      }
      const dueAt = daysAfter(now, config.noticeDays);
      const recipients = await this.notices.organizationRecipients(
        manager,
        candidate.id,
      );
      const result = await this.notices.send(
        manager,
        {
          subjectType: 'organization',
          subjectId: candidate.id,
          kind: 'organization_inactivity',
          now,
          dueAt,
          activityAt: new Date(candidate.activity),
        },
        recipients,
        (to) =>
          organizationInactivityMail({
            to,
            appUrl: this.notices.appUrl,
            organizationName: candidate.name,
            lastActivityAt: new Date(candidate.activity),
            dueAt,
            inactiveMonths: config.inactiveOrganizationMonths,
            exportPeriodDays: config.exportPeriodDays,
          }),
      );
      if (!result.recorded) ctx.note('noticesFailed', 1);
      else if (recipients.length === 0) ctx.note('noticesWithoutRecipient', 1);
      else ctx.note('noticesSent', 1);
    }
  }
}
