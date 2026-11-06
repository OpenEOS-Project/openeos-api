import { daysLeft, dueReminder } from '../retention.config';
import {
  accountDeletionScheduledMail,
  organizationDeletionReminderMail,
  organizationInactivityReminderMail,
  type RetentionMail,
} from '../retention-mails';
import type { RetentionNoticeService } from '../retention-notice.service';
import { select } from '../retention-sql';
import type { RetentionJob, RetentionRunContext } from '../retention.types';

interface ReminderRow {
  id: string;
  subject_type: 'organization' | 'user';
  subject_id: string;
  kind:
    | 'organization_inactivity'
    | 'organization_deletion'
    | 'account_deletion';
  sent_at: Date;
  due_at: Date;
  reminder_days: number | null;
  details: { organizationIds?: string[] } | null;
  org_name: string | null;
  org_deleted_at: Date | null;
  closed_for_inactivity: boolean;
  user_email: string | null;
  user_deleted_at: Date | null;
  user_deletion_due_at: Date | null;
}

/**
 * Erinnerungen 30, 10 und 1 Tag vor jeder angekuendigten Schliessung bzw.
 * endgueltigen Loeschung: Organisation geloescht (durch den Verein oder
 * nach Inaktivitaet geschlossen), Schliessung wegen Inaktivitaet und
 * Kontoloeschung mit der Organisation des einzigen Mitglieds.
 *
 * - Die Ankuendigung selbst ist die 30-Tage-Erinnerung (`dueReminder`).
 * - Jede Stufe geht hoechstens einmal raus (`retention_notices.reminder_days`).
 *   Hat der Lauf Tage verpasst, kommt nur die juengste faellige Stufe.
 * - Aufgehobene, ausgefuehrte oder ueberholte Ankuendigungen (Organisation
 *   wiederhergestellt bzw. wieder genutzt) bekommen keine Erinnerung.
 * - Organisationen, deren Admins alle ihr Konto mitloeschen lassen, bekommen
 *   keine eigene Erinnerung: die Erinnerung zur Kontoloeschung nennt sie.
 * - Probelauf: nur zaehlen (`remindersDue`), keine Mails.
 * - Scheitert der Versand an alle Empfaenger, versucht es der naechste Lauf
 *   erneut.
 */
export class DeletionRemindersJob implements RetentionJob {
  readonly category = 'deletion_reminders' as const;

  constructor(
    private readonly notices: RetentionNoticeService,
    private readonly options: { contactEmail: string | null },
  ) {}

  async run(ctx: RetentionRunContext): Promise<void> {
    const { manager, now } = ctx;
    const rows = await select<ReminderRow>(
      manager,
      `SELECT n.id, n.subject_type, n.subject_id, n.kind, n.sent_at, n.due_at,
              n.reminder_days, n.details,
              o.name AS org_name, o.deleted_at AS org_deleted_at,
              EXISTS (SELECT 1 FROM retention_notices i
                       WHERE i.subject_type = 'organization' AND i.subject_id = n.subject_id
                         AND i.kind = 'organization_inactivity'
                         AND i.executed_at IS NOT NULL) AS closed_for_inactivity,
              u.email AS user_email, u.deleted_at AS user_deleted_at,
              u.deletion_due_at AS user_deletion_due_at
         FROM retention_notices n
         LEFT JOIN organizations o
                ON n.subject_type = 'organization' AND o.id = n.subject_id
         LEFT JOIN users u ON n.subject_type = 'user' AND u.id = n.subject_id
        WHERE n.kind IN ('organization_inactivity', 'organization_deletion', 'account_deletion')
          AND n.executed_at IS NULL AND n.cancelled_at IS NULL
          AND n.due_at > $1
        ORDER BY n.due_at`,
      [now],
    );

    for (const row of rows) {
      const step = dueReminder({
        sentAt: new Date(row.sent_at),
        dueAt: new Date(row.due_at),
        now,
        lastReminderDays:
          row.reminder_days === null ? null : Number(row.reminder_days),
      });
      if (step === null) continue;
      if (this.outdated(row)) {
        ctx.note('remindersSkippedOutdated', 1);
        continue;
      }
      if (ctx.dryRun) {
        ctx.note('remindersDue', 1);
        continue;
      }

      const target = await this.target(ctx, row);
      if (target === 'covered') {
        await this.markSent(ctx, row.id, step);
        ctx.note('remindersCoveredByAccount', 1);
        continue;
      }
      const delivered = await this.notices.deliver(
        target.recipients,
        target.compose,
        `Reminder ${row.kind} ${row.subject_id}`,
      );
      if (target.recipients.length > 0 && delivered === 0) {
        ctx.note('remindersFailed', 1);
        continue;
      }
      await this.markSent(ctx, row.id, step);
      ctx.note(
        target.recipients.length === 0
          ? 'remindersWithoutRecipient'
          : `remindersSent${step}d`,
        1,
      );
    }
  }

  /** Ankuendigung passt nicht mehr zum Zustand (die Jobs davor raeumen auf). */
  private outdated(row: ReminderRow): boolean {
    switch (row.kind) {
      case 'organization_deletion':
        return row.org_name === null || row.org_deleted_at === null;
      case 'organization_inactivity':
        return row.org_name === null || row.org_deleted_at !== null;
      case 'account_deletion':
        return (
          row.user_email === null ||
          row.user_deleted_at !== null ||
          row.user_deletion_due_at === null
        );
    }
  }

  private async markSent(
    ctx: RetentionRunContext,
    id: string,
    step: number,
  ): Promise<void> {
    await ctx.manager.query(
      `UPDATE retention_notices SET reminder_days = $2, reminded_at = $3
        WHERE id = $1`,
      [id, step, ctx.now],
    );
  }

  private async target(
    ctx: RetentionRunContext,
    row: ReminderRow,
  ): Promise<
    'covered' | { recipients: string[]; compose: (to: string) => RetentionMail }
  > {
    const { manager, now, config } = ctx;
    const dueAt = new Date(row.due_at);
    const left = daysLeft(dueAt, now);
    const appUrl = this.notices.appUrl;

    if (row.kind === 'account_deletion') {
      const ids = row.details?.organizationIds ?? [];
      const names = await select<{ name: string }>(
        manager,
        `SELECT name FROM organizations WHERE id = ANY($1::uuid[]) ORDER BY name`,
        [ids],
      );
      return {
        recipients: [row.user_email!],
        compose: (to) =>
          accountDeletionScheduledMail({
            to,
            appUrl,
            organizations: names.map((n) => n.name),
            requestedAt: new Date(row.sent_at),
            dueAt,
            daysLeft: left,
          }),
      };
    }

    const admins = await select<{ email: string; scheduled: boolean }>(
      manager,
      `SELECT DISTINCT u.email, (u.deletion_due_at IS NOT NULL) AS scheduled
         FROM user_organizations uo
         JOIN users u ON u.id = uo.user_id
        WHERE uo.organization_id = $1 AND uo.role = 'admin'
          AND u.deleted_at IS NULL AND u.is_active = true`,
      [row.subject_id],
    );
    const recipients = admins.filter((a) => !a.scheduled).map((a) => a.email);
    if (admins.length > 0 && recipients.length === 0) return 'covered';
    if (admins.length === 0) {
      recipients.push(
        ...(await this.notices.organizationRecipients(manager, row.subject_id)),
      );
    }
    const organizationName = row.org_name!;

    if (row.kind === 'organization_inactivity') {
      return {
        recipients,
        compose: (to) =>
          organizationInactivityReminderMail({
            to,
            appUrl,
            organizationName,
            dueAt,
            daysLeft: left,
            exportPeriodDays: config.exportPeriodDays,
          }),
      };
    }
    return {
      recipients,
      compose: (to) =>
        organizationDeletionReminderMail({
          to,
          appUrl,
          organizationName,
          deletedAt: new Date(row.org_deleted_at!),
          closedForInactivity: row.closed_for_inactivity === true,
          dueAt,
          daysLeft: left,
          contactEmail: this.options.contactEmail,
        }),
    };
  }
}
