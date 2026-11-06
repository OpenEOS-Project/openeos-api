import {
  daysAfter,
  exportOfferHonoured,
  monthsBefore,
} from '../retention.config';
import { accountDeletedMail, userInactivityMail } from '../retention-mails';
import type { RetentionNoticeService } from '../retention-notice.service';
import { USER_ACTIVITY_SQL, affected, select } from '../retention-sql';
import type { RetentionJob, RetentionRunContext } from '../retention.types';
import {
  removeOwnerUploads,
  type PurgeOptions,
} from './organization-purge.job';

/**
 * Benutzer ohne Mitgliedschaft in einer bestehenden Organisation (ohne
 * geplante Kontoloeschung, die laeuft eigens).
 */
const WITHOUT_ORGANIZATION_SQL = `u.deleted_at IS NULL AND u.is_superadmin = false
  AND u.deletion_due_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM user_organizations uo
                    JOIN organizations org ON org.id = uo.organization_id
                   WHERE uo.user_id = u.id AND org.deleted_at IS NULL)`;

/**
 * Benutzerkonten, die keiner bestehenden Organisation mehr angehoeren und
 * `RETENTION_INACTIVE_USER_MONTHS` (24) Monate nicht genutzt wurden:
 * Ankuendigung per Mail, fruehestens `RETENTION_NOTICE_DAYS` (30) Tage
 * spaeter wird das Konto anonymisiert (Name, E-Mail, Zugangsdaten,
 * Sitzungen, Tokens, Avatar). Eine Anmeldung oder eine neue Mitgliedschaft
 * hebt die Ankuendigung auf.
 *
 * Bedienernamen in bereits erstellten Kassenabschluessen bleiben (sie
 * stehen im Abschluss selbst); Konten mit Vorgaengen, die noch keinem
 * Abschluss zugeordnet sind, werden nicht angefasst.
 *
 * Ausserdem: geplante Kontoloeschungen („Konto löschen“ als einziges
 * Mitglied einer Organisation, Ankuendigung `account_deletion`). Das Konto
 * wird anonymisiert, sobald der Termin erreicht ist und seine
 * Organisationen endgueltig geloescht sind (`organization_purge` laeuft
 * vorher und entfernt dabei die Mitgliedschaften).
 */
export class UserAccountsJob implements RetentionJob {
  readonly category = 'user_accounts' as const;

  constructor(
    private readonly notices: RetentionNoticeService,
    private readonly options: Pick<
      PurgeOptions,
      'uploadDir' | 'fiscalExportDir'
    >,
  ) {}

  async run(ctx: RetentionRunContext): Promise<void> {
    const { manager, now, config } = ctx;
    const cutoff = monthsBefore(now, config.inactiveUserMonths);

    await this.runScheduled(ctx);

    const open = await select<{
      id: string;
      subject_id: string;
      sent_at: Date;
      due_at: Date;
      activity_at: Date | null;
      activity: Date | null;
      orphan: boolean;
      unclosed: boolean;
    }>(
      manager,
      `SELECT n.id, n.subject_id, n.sent_at, n.due_at, n.activity_at,
              ${USER_ACTIVITY_SQL} AS activity,
              (${WITHOUT_ORGANIZATION_SQL}) AS orphan,
              EXISTS (SELECT 1 FROM tse_transactions t WHERE t.user_id = u.id
                        AND t.cash_point_closing_id IS NULL) AS unclosed
         FROM retention_notices n
         JOIN users u ON u.id = n.subject_id
        WHERE n.subject_type = 'user' AND n.kind = 'user_inactivity'
          AND n.executed_at IS NULL AND n.cancelled_at IS NULL`,
    );
    const pending = new Set<string>();
    for (const notice of open) {
      pending.add(notice.subject_id);
      if (
        !notice.orphan ||
        new Date(notice.activity ?? 0).getTime() >
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
      if (notice.unclosed) {
        ctx.note('skippedUnclosedTransactions', 1);
        continue;
      }
      await this.anonymise(ctx, notice.subject_id);
      await this.notices.markExecuted(manager, notice.id, now);
      ctx.removed('accountsAnonymised', 1);
    }

    const candidates = await select<{
      id: string;
      email: string;
      activity: Date;
    }>(
      manager,
      `SELECT u.id, u.email, ${USER_ACTIVITY_SQL} AS activity
         FROM users u
        WHERE ${WITHOUT_ORGANIZATION_SQL} AND ${USER_ACTIVITY_SQL} < $1`,
      [cutoff],
    );
    for (const candidate of candidates) {
      if (pending.has(candidate.id)) continue;
      if (ctx.dryRun) {
        ctx.note('noticesDue', 1);
        continue;
      }
      const dueAt = daysAfter(now, config.noticeDays);
      const result = await this.notices.send(
        manager,
        {
          subjectType: 'user',
          subjectId: candidate.id,
          kind: 'user_inactivity',
          now,
          dueAt,
          activityAt: new Date(candidate.activity),
        },
        [candidate.email],
        (to) =>
          userInactivityMail({
            to,
            appUrl: this.notices.appUrl,
            inactiveMonths: config.inactiveUserMonths,
            dueAt,
          }),
      );
      ctx.note(result.recorded ? 'noticesSent' : 'noticesFailed', 1);
    }
  }

  /** Geplante Kontoloeschungen ausfuehren, die faellig sind. */
  private async runScheduled(ctx: RetentionRunContext): Promise<void> {
    const { manager, now, config } = ctx;
    const scheduled = await select<{
      id: string;
      subject_id: string;
      sent_at: Date;
      due_at: Date;
      details: { organizationIds?: string[] } | null;
      email: string;
      deleted_at: Date | null;
      deletion_due_at: Date | null;
      pending_organizations: boolean;
      unclosed: boolean;
    }>(
      manager,
      `SELECT n.id, n.subject_id, n.sent_at, n.due_at, n.details,
              u.email, u.deleted_at, u.deletion_due_at,
              EXISTS (SELECT 1 FROM user_organizations uo
                        JOIN organizations org ON org.id = uo.organization_id
                       WHERE uo.user_id = u.id AND org.deleted_at IS NOT NULL) AS pending_organizations,
              EXISTS (SELECT 1 FROM tse_transactions t WHERE t.user_id = u.id
                        AND t.cash_point_closing_id IS NULL) AS unclosed
         FROM retention_notices n
         JOIN users u ON u.id = n.subject_id
        WHERE n.subject_type = 'user' AND n.kind = 'account_deletion'
          AND n.executed_at IS NULL AND n.cancelled_at IS NULL`,
    );
    for (const notice of scheduled) {
      if (notice.deleted_at) {
        await this.notices.markExecuted(manager, notice.id, now);
        continue;
      }
      if (!notice.deletion_due_at) {
        await this.notices.cancel(manager, notice.id, now, 'cancelled');
        ctx.note('scheduledDeletionsCancelled', 1);
        continue;
      }
      if (
        new Date(notice.due_at) > now ||
        !exportOfferHonoured(new Date(notice.sent_at), now, config.noticeDays)
      ) {
        ctx.note('scheduledDeletionsWaiting', 1);
        continue;
      }
      if (notice.pending_organizations) {
        ctx.note('skippedOrganizationPending', 1);
        continue;
      }
      if (notice.unclosed) {
        ctx.note('skippedUnclosedTransactions', 1);
        continue;
      }
      const names = await select<{ name: string }>(
        manager,
        `SELECT name FROM organizations WHERE id = ANY($1::uuid[]) ORDER BY name`,
        [notice.details?.organizationIds ?? []],
      );
      await this.anonymise(ctx, notice.subject_id);
      await this.notices.markExecuted(manager, notice.id, now);
      ctx.removed('accountsAnonymised', 1);
      ctx.note('scheduledDeletionsExecuted', 1);
      const email = notice.email;
      ctx.afterCommit(async () => {
        await this.notices.deliver(
          [email],
          (to) =>
            accountDeletedMail({
              to,
              appUrl: this.notices.appUrl,
              deletedAt: now,
              purgedOrganizations: names.map((n) => n.name),
            }),
          `Account deleted ${notice.subject_id}`,
        );
      });
    }
  }

  /** Entfernt alle personenbezogenen Angaben eines Kontos ($1). */
  async anonymise(ctx: RetentionRunContext, userId: string): Promise<void> {
    const { manager, now } = ctx;
    for (const table of [
      'refresh_tokens',
      'trusted_devices',
      'email_otps',
      'login_magic_links',
      'api_tokens',
      'user_organizations',
    ]) {
      await affected(manager, `DELETE FROM ${table} WHERE user_id = $1`, [
        userId,
      ]);
    }
    await affected(
      manager,
      `UPDATE users SET
          email = 'deleted-' || id::text || '@deleted.invalid',
          first_name = 'Gelöschtes',
          last_name = 'Konto',
          password_hash = NULL,
          avatar_url = NULL,
          is_active = false,
          email_verification_token = NULL,
          email_verification_expires_at = NULL,
          password_reset_token = NULL,
          password_reset_expires_at = NULL,
          two_factor_enabled = false,
          two_factor_method = NULL,
          two_factor_secret_encrypted = NULL,
          two_factor_backup_codes_hash = NULL,
          pending_email = NULL,
          pending_email_token = NULL,
          pending_email_expires_at = NULL,
          newsletter_opt_in_at = NULL,
          newsletter_opt_out_at = NULL,
          preferences = DEFAULT,
          deleted_at = $2
        WHERE id = $1`,
      [userId, now],
    );
    ctx.afterCommit(() =>
      removeOwnerUploads(
        this.options.uploadDir,
        this.options.fiscalExportDir,
        userId,
      ),
    );
  }
}
