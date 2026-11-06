import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';

import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { EncryptionService } from '../../common/services/encryption.service';
import type { RetentionRun } from '../../database/entities';
import type { UserAccountsJob } from './jobs/user-accounts.job';
import {
  ORGANIZATION_PURGED_SQL,
  restoreOrganization,
} from './organization-restore';
import { daysAfter } from './retention.config';
import {
  accountDeletedMail,
  accountDeletionCodeMail,
  accountDeletionScheduledMail,
} from './retention-mails';
import { RetentionNoticeService } from './retention-notice.service';
import { affected, select } from './retention-sql';
import { RetentionService } from './retention.service';
import { RETENTION_JOBS, type RetentionJob } from './retention.types';

export const ACCOUNT_DELETION_CODE_MINUTES = 15;
const CODE_LENGTH = 6;
const MAX_CODE_ATTEMPTS = 5;

export type AccountDeletionBlockReason =
  | 'members'
  | 'active_events'
  | 'tse_active';

export interface AccountDeletionStatus {
  /** Darf das Konto jetzt geloescht werden? */
  allowed: boolean;
  /** Wie bestaetigt wird: Passwort oder Code per E-Mail. */
  confirmation: 'password' | 'email_code';
  superAdmin: boolean;
  /** Kassenvorgaenge ohne Kassenabschluss (Bediener muss feststehen). */
  unclosedTransactions: boolean;
  /**
   * Organisationen, deren einziger Administrator der Benutzer ist und die
   * noch weitere Mitglieder, laufende Veranstaltungen oder eine aktive
   * Cloud-TSE haben: erst uebergeben bzw. verlassen.
   */
  blockers: Array<{
    organizationId: string;
    name: string;
    reason: AccountDeletionBlockReason;
  }>;
  /**
   * Organisationen ohne weitere Mitglieder, deren einziger Administrator er
   * ist: sie werden mit dem Konto geloescht. Dann wird auch das Konto erst
   * mit ihnen endgueltig geloescht (`scheduledDeletionAt`).
   */
  closesOrganizations: Array<{ organizationId: string; name: string }>;
  /**
   * Termin der endgueltigen Loeschung, wenn jetzt geloescht wird und
   * Organisationen mitgehen; sonst `null` (sofortige Loeschung).
   */
  scheduledDeletionAt: Date | null;
  /** Bereits geplante Loeschung (Konto und Organisationen), sonst `null`. */
  scheduled: ScheduledAccountDeletion | null;
}

export interface ScheduledAccountDeletion {
  requestedAt: Date;
  dueAt: Date;
  organizations: Array<{ organizationId: string; name: string }>;
}

export interface AccountDeletionResult {
  run: RetentionRun;
  /** Gesetzt, wenn das Konto erst mit den Organisationen geloescht wird. */
  scheduled: ScheduledAccountDeletion | null;
}

interface MembershipRow {
  organization_id: string;
  name: string;
  role: string;
  other_members: number;
  other_admins: number;
  active_events: number;
  tse_live: boolean;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  is_superadmin: boolean;
  deletion_due_at: Date | null;
}

/**
 * „Konto löschen“ im Selbstbedienen (Art. 17 DSGVO, Loeschkonzept 5.1).
 *
 * Das Konto wird genau wie beim Loeschlauf fuer ungenutzte Konten
 * anonymisiert (`UserAccountsJob.anonymise`): Name, E-Mail, Zugangsdaten,
 * Sitzungen, Tokens, Mitgliedschaften und Avatar entfallen; Bedienernamen in
 * bestehenden Kassenabschluessen bleiben. Der Vorgang steht im Protokoll der
 * Loeschlaeufe (Ausloeser `self_service`).
 *
 * Ist der Benutzer einziges Mitglied einer Organisation, geht sie mit. Damit
 * jemand die 30-taegige Exportfrist nutzen kann (AGB 10.4), wird das Konto
 * dann nicht sofort anonymisiert, sondern zum Termin der endgueltigen
 * Loeschung der Organisation (`users.deletion_due_at`, Ankuendigung
 * `account_deletion`). Bis dahin kann sich der Benutzer anmelden und die
 * Organisation lesend nutzen und exportieren, aber nichts anlegen und keiner
 * Organisation beitreten; Mitgliedschaften in anderen Organisationen und
 * API-Tokens entfallen sofort. „Löschung abbrechen“ holt Konto und
 * Organisation zurueck, solange nicht endgueltig geloescht ist. Die
 * Anonymisierung erledigt der naechtliche Lauf `user_accounts`.
 *
 * Gesperrt ist das Loeschen, solange der Benutzer der letzte Administrator
 * einer Organisation mit weiteren Mitgliedern, laufenden Veranstaltungen
 * oder aktiver Cloud-TSE ist, solange er Super-Admin ist und solange er
 * Kassenvorgaenge ohne Kassenabschluss hat. Organisationen, deren einziges
 * Mitglied er ist, werden mit geloescht (wie „Organisation löschen“).
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly retention: RetentionService,
    private readonly notices: RetentionNoticeService,
    private readonly encryption: EncryptionService,
    @Inject(RETENTION_JOBS) private readonly jobs: RetentionJob[],
  ) {}

  private get userJob(): UserAccountsJob {
    const job = this.jobs.find((j) => j.category === 'user_accounts');
    if (!job) throw new Error('user_accounts job missing');
    return job as UserAccountsJob;
  }

  private async user(userId: string): Promise<UserRow> {
    const [user] = await this.retention.query<UserRow>(
      `SELECT id, email, password_hash, is_superadmin, deletion_due_at FROM users
        WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    if (!user) {
      throw new ForbiddenException({
        code: ErrorCodes.UNAUTHORIZED,
        reason: ErrorReasons.USER_NOT_FOUND,
        message: 'Benutzer nicht gefunden',
      });
    }
    return user;
  }

  async status(userId: string): Promise<AccountDeletionStatus> {
    const user = await this.user(userId);
    const memberships = await this.retention.query<MembershipRow>(
      `SELECT uo.organization_id, o.name, uo.role,
              (SELECT count(*)::int FROM user_organizations x
                WHERE x.organization_id = o.id AND x.user_id <> $1) AS other_members,
              (SELECT count(*)::int FROM user_organizations x
                WHERE x.organization_id = o.id AND x.user_id <> $1
                  AND x.role = 'admin') AS other_admins,
              (SELECT count(*)::int FROM events e
                WHERE e.organization_id = o.id AND e.deleted_at IS NULL
                  AND (e.status = 'active'
                       OR (e.end_date IS NOT NULL AND e.end_date > now()
                           AND e.billing_status IN ('pending', 'paid', 'invoice')))
              ) AS active_events,
              EXISTS (SELECT 1 FROM tse_units t WHERE t.organization_id = o.id
                        AND t.state IN ('creating', 'active')) AS tse_live
         FROM user_organizations uo
         JOIN organizations o ON o.id = uo.organization_id
        WHERE uo.user_id = $1 AND o.deleted_at IS NULL
        ORDER BY o.name`,
      [userId],
    );
    const blockers: AccountDeletionStatus['blockers'] = [];
    const closesOrganizations: AccountDeletionStatus['closesOrganizations'] =
      [];
    for (const m of memberships) {
      if (m.role !== 'admin' || Number(m.other_admins) > 0) continue;
      const reason: AccountDeletionBlockReason | null =
        Number(m.other_members) > 0
          ? 'members'
          : Number(m.active_events) > 0
            ? 'active_events'
            : m.tse_live
              ? 'tse_active'
              : null;
      if (reason) {
        blockers.push({
          organizationId: m.organization_id,
          name: m.name,
          reason,
        });
      } else {
        closesOrganizations.push({
          organizationId: m.organization_id,
          name: m.name,
        });
      }
    }
    const [unclosed] = await this.retention.query<{ unclosed: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM tse_transactions
                       WHERE user_id = $1 AND cash_point_closing_id IS NULL) AS unclosed`,
      [userId],
    );
    const unclosedTransactions = unclosed?.unclosed === true;
    const scheduled = user.deletion_due_at
      ? await this.scheduledDeletion(user.id)
      : null;
    return {
      allowed:
        !user.is_superadmin &&
        !scheduled &&
        blockers.length === 0 &&
        !unclosedTransactions,
      confirmation: user.password_hash ? 'password' : 'email_code',
      superAdmin: user.is_superadmin,
      unclosedTransactions,
      blockers,
      closesOrganizations,
      scheduledDeletionAt:
        closesOrganizations.length > 0
          ? this.finalDeletionDate(new Date())
          : null,
      scheduled,
    };
  }

  /** Termin der endgueltigen Loeschung einer jetzt geloeschten Organisation. */
  private finalDeletionDate(now: Date): Date {
    const { exportPeriodDays, noticeDays } = this.retention.config;
    return daysAfter(now, Math.max(exportPeriodDays, noticeDays));
  }

  /** Offene geplante Loeschung des Kontos mit ihren Organisationen. */
  async scheduledDeletion(
    userId: string,
  ): Promise<ScheduledAccountDeletion | null> {
    const [notice] = await this.retention.query<{
      sent_at: Date;
      due_at: Date;
      details: { organizationIds?: string[] } | null;
    }>(
      `SELECT n.sent_at, n.due_at, n.details FROM retention_notices n
         JOIN users u ON u.id = n.subject_id
        WHERE n.subject_type = 'user' AND n.subject_id = $1
          AND n.kind = 'account_deletion'
          AND n.executed_at IS NULL AND n.cancelled_at IS NULL
          AND u.deletion_due_at IS NOT NULL`,
      [userId],
    );
    if (!notice) return null;
    const ids = notice.details?.organizationIds ?? [];
    const organizations = await this.retention.query<{
      id: string;
      name: string;
    }>(
      `SELECT id, name FROM organizations WHERE id = ANY($1::uuid[]) ORDER BY name`,
      [ids],
    );
    return {
      requestedAt: new Date(notice.sent_at),
      dueAt: new Date(notice.due_at),
      organizations: organizations.map((o) => ({
        organizationId: o.id,
        name: o.name,
      })),
    };
  }

  /** Code per E-Mail fuer Konten ohne Passwort (bzw. auf Wunsch). */
  async sendCode(userId: string): Promise<void> {
    const user = await this.user(userId);
    const manager = this.retention.manager;
    await manager.query(
      `UPDATE email_otps SET used_at = now()
        WHERE user_id = $1 AND purpose = 'account_deletion' AND used_at IS NULL`,
      [user.id],
    );
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += randomInt(10).toString();
    await manager.query(
      `INSERT INTO email_otps (user_id, code_hash, purpose, max_attempts, expires_at)
       VALUES ($1, $2, 'account_deletion', $3, $4)`,
      [
        user.id,
        this.encryption.hashCode(code),
        MAX_CODE_ATTEMPTS,
        new Date(Date.now() + ACCOUNT_DELETION_CODE_MINUTES * 60 * 1000),
      ],
    );
    const delivered = await this.notices.deliver(
      [user.email],
      (to) =>
        accountDeletionCodeMail({
          to,
          appUrl: this.notices.appUrl,
          code,
          validMinutes: ACCOUNT_DELETION_CODE_MINUTES,
        }),
      `Account deletion code ${user.id}`,
    );
    if (delivered === 0) {
      this.logger.error(`Account deletion code for ${user.id} not delivered`);
    }
  }

  private async verifyCode(userId: string, code: string): Promise<boolean> {
    const manager = this.retention.manager;
    const [otp] = await this.retention.query<{
      id: string;
      code_hash: string;
      attempts: number;
      max_attempts: number;
      expires_at: Date;
    }>(
      `SELECT id, code_hash, attempts, max_attempts, expires_at FROM email_otps
        WHERE user_id = $1 AND purpose = 'account_deletion' AND used_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    if (!otp) return false;
    if (new Date(otp.expires_at) < new Date()) return false;
    if (otp.attempts >= otp.max_attempts) return false;
    const normalized = code.replace(/\s+/g, '');
    let valid = false;
    try {
      valid = this.encryption.verifyCode(normalized, otp.code_hash);
    } catch {
      valid = false;
    }
    await manager.query(
      valid
        ? `UPDATE email_otps SET used_at = now() WHERE id = $1`
        : `UPDATE email_otps SET attempts = attempts + 1 WHERE id = $1`,
      [otp.id],
    );
    return valid;
  }

  /**
   * Loescht (anonymisiert) das Konto nach Bestaetigung bzw. plant die
   * Loeschung, wenn Organisationen mitgehen. Liefert den Protokolleintrag;
   * die Bestaetigungsmail geht an die bisherige Adresse.
   */
  async deleteAccount(
    userId: string,
    confirmation: { password?: string; code?: string },
  ): Promise<AccountDeletionResult> {
    const user = await this.user(userId);
    const status = await this.status(userId);
    if (status.scheduled) {
      throw new ConflictException({
        code: ErrorCodes.CONFLICT,
        reason: ErrorReasons.ACCOUNT_DELETION_SCHEDULED,
        message: 'Die Löschung deines Kontos ist bereits geplant.',
      });
    }
    if (status.superAdmin) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.ACCOUNT_DELETION_SUPER_ADMIN,
        message:
          'Super-Admin-Konten lassen sich nicht selbst löschen. Lass dir die Super-Admin-Rechte zuerst entziehen.',
      });
    }
    if (status.blockers.length > 0) {
      throw new ConflictException({
        code: ErrorCodes.CONFLICT,
        reason: ErrorReasons.ACCOUNT_DELETION_BLOCKED,
        message: `Du bist der letzte Administrator von ${status.blockers
          .map((b) => `„${b.name}“`)
          .join(
            ', ',
          )}. Ernenne zuerst eine andere Person zum Administrator oder verlasse bzw. lösche die Organisation.`,
        params: {
          organizations: status.blockers.map((b) => b.name).join(', '),
        },
      });
    }
    if (status.unclosedTransactions) {
      throw new ConflictException({
        code: ErrorCodes.CONFLICT,
        reason: ErrorReasons.ACCOUNT_DELETION_UNCLOSED_TRANSACTIONS,
        message:
          'Du hast Kassenvorgänge gebucht, die noch keinem Kassenabschluss zugeordnet sind. Bitte deinen Verein, zuerst den Kassenabschluss zu erstellen.',
      });
    }

    if (user.password_hash) {
      if (!confirmation.password) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.ACCOUNT_DELETION_CONFIRMATION_REQUIRED,
          message: 'Bitte bestätige mit deinem Passwort.',
        });
      }
      if (!(await bcrypt.compare(confirmation.password, user.password_hash))) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.ACCOUNT_DELETION_PASSWORD_INVALID,
          message: 'Das Passwort stimmt nicht.',
        });
      }
    } else {
      if (!confirmation.code) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.ACCOUNT_DELETION_CONFIRMATION_REQUIRED,
          message: 'Bitte bestätige mit dem Code aus der E-Mail.',
        });
      }
      if (!(await this.verifyCode(user.id, confirmation.code))) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.ACCOUNT_DELETION_CODE_INVALID,
          message:
            'Der Code ist ungültig oder abgelaufen. Fordere einen neuen an.',
        });
      }
    }

    if (status.closesOrganizations.length > 0) {
      return this.scheduleDeletion(user, status.closesOrganizations);
    }

    const job = this.userJob;
    const run = await this.retention.runJob(
      {
        category: 'user_accounts',
        run: async (ctx) => {
          await job.anonymise(ctx, user.id);
          await ctx.manager.query(
            `UPDATE retention_notices SET executed_at = $2
              WHERE subject_type = 'user' AND subject_id = $1
                AND kind = 'user_inactivity'
                AND executed_at IS NULL AND cancelled_at IS NULL`,
            [user.id, ctx.now],
          );
          ctx.removed('accountsAnonymised', 1);
        },
      },
      {
        trigger: 'self_service',
        dryRun: false,
        executedByUserId: user.id,
        reason: 'Konto selbst gelöscht',
      },
    );
    if (run.status !== 'succeeded') {
      throw new InternalServerErrorException({
        code: ErrorCodes.INTERNAL_ERROR,
        message:
          'Dein Konto konnte gerade nicht gelöscht werden. Versuch es bitte später noch einmal.',
      });
    }

    await this.notices.deliver(
      [user.email],
      (to) =>
        accountDeletedMail({
          to,
          appUrl: this.notices.appUrl,
          deletedAt: run.finishedAt ?? new Date(),
        }),
      `Account deleted ${user.id}`,
    );
    return { run, scheduled: null };
  }

  /**
   * Konto mit Organisation(en) des einzigen Mitglieds: Organisationen
   * schliessen (nur lesend), endgueltige Loeschung fuer Organisationen und
   * Konto gemeinsam ankuendigen, Mitgliedschaften in anderen Organisationen
   * und API-Tokens sofort entfernen. Die Bestaetigungsmail ist zugleich die
   * Erinnerung 30 Tage vorher.
   */
  private async scheduleDeletion(
    user: UserRow,
    organizations: Array<{ organizationId: string; name: string }>,
  ): Promise<AccountDeletionResult> {
    const ids = organizations.map((o) => o.organizationId);
    const state: { now: Date | null; dueAt: Date | null } = {
      now: null,
      dueAt: null,
    };
    const run = await this.retention.runJob(
      {
        category: 'user_accounts',
        run: async (ctx) => {
          const { manager, now } = ctx;
          const dueAt = this.finalDeletionDate(now);
          state.now = now;
          state.dueAt = dueAt;
          ctx.removed(
            'organizationsClosed',
            await affected(
              manager,
              `UPDATE organizations SET deleted_at = $2
                WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
              [ids, now],
            ),
          );
          ctx.removed(
            'membershipsDeleted',
            await affected(
              manager,
              `DELETE FROM user_organizations
                WHERE user_id = $1 AND NOT (organization_id = ANY($2::uuid[]))
                  AND organization_id IN (SELECT id FROM organizations WHERE deleted_at IS NULL)`,
              [user.id, ids],
            ),
          );
          ctx.removed(
            'apiTokensDeleted',
            await affected(
              manager,
              `DELETE FROM api_tokens WHERE user_id = $1`,
              [user.id],
            ),
          );
          for (const id of ids) {
            await manager.query(
              `INSERT INTO retention_notices
                 (subject_type, subject_id, kind, sent_at, recipient_count, due_at, activity_at)
               SELECT 'organization', $1, 'organization_deletion', $2, 1, $3, $2
                WHERE NOT EXISTS (SELECT 1 FROM retention_notices
                                   WHERE subject_type = 'organization' AND subject_id = $1
                                     AND kind = 'organization_deletion'
                                     AND executed_at IS NULL AND cancelled_at IS NULL)`,
              [id, now, dueAt],
            );
          }
          await manager.query(
            `UPDATE retention_notices SET cancelled_at = $2, cancel_reason = 'scheduled'
              WHERE subject_type = 'user' AND subject_id = $1
                AND kind = 'user_inactivity'
                AND executed_at IS NULL AND cancelled_at IS NULL`,
            [user.id, now],
          );
          await manager.query(
            `INSERT INTO retention_notices
               (subject_type, subject_id, kind, sent_at, recipient_count, due_at, activity_at, details)
             VALUES ('user', $1, 'account_deletion', $2, 1, $3, $2, $4)`,
            [user.id, now, dueAt, JSON.stringify({ organizationIds: ids })],
          );
          await manager.query(
            `UPDATE users SET deletion_due_at = $2 WHERE id = $1`,
            [user.id, dueAt],
          );
          ctx.note('accountDeletionsScheduled', 1);
        },
      },
      {
        trigger: 'self_service',
        dryRun: false,
        executedByUserId: user.id,
        reason:
          'Konto selbst gelöscht (mit Organisation, endgültig zum Termin)',
        details: { organizationIds: ids },
      },
    );
    if (run.status !== 'succeeded' || !state.now || !state.dueAt) {
      throw new InternalServerErrorException({
        code: ErrorCodes.INTERNAL_ERROR,
        message:
          'Dein Konto konnte gerade nicht gelöscht werden. Versuch es bitte später noch einmal.',
      });
    }
    const scheduled: ScheduledAccountDeletion = {
      requestedAt: state.now,
      dueAt: state.dueAt,
      organizations,
    };
    await this.notices.deliver(
      [user.email],
      (to) =>
        accountDeletionScheduledMail({
          to,
          appUrl: this.notices.appUrl,
          organizations: organizations.map((o) => o.name),
          requestedAt: scheduled.requestedAt,
          dueAt: scheduled.dueAt,
        }),
      `Account deletion scheduled ${user.id}`,
    );
    return { run, scheduled };
  }

  /**
   * „Löschung abbrechen“: holt Konto und Organisationen einer geplanten
   * Loeschung zurueck, solange keine Organisation endgueltig geloescht ist.
   * Entfernte Mitgliedschaften in anderen Organisationen und API-Tokens
   * bleiben weg. Steht im Protokoll (Ausloeser `self_service`).
   */
  async cancelScheduledDeletion(userId: string): Promise<RetentionRun> {
    const user = await this.user(userId);
    const scheduled = user.deletion_due_at
      ? await this.scheduledDeletion(user.id)
      : null;
    if (!scheduled) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.ACCOUNT_DELETION_NOT_SCHEDULED,
        message: 'Für dein Konto ist keine Löschung geplant.',
      });
    }
    const ids = scheduled.organizations.map((o) => o.organizationId);
    const purged = await select<{ id: string }>(
      this.retention.manager,
      `SELECT o.id FROM organizations o
        WHERE o.id = ANY($1::uuid[]) AND ${ORGANIZATION_PURGED_SQL}`,
      [ids],
    );
    if (purged.length > 0) {
      throw new ConflictException({
        code: ErrorCodes.CONFLICT,
        reason: ErrorReasons.ORGANIZATION_ALREADY_PURGED,
        message:
          'Die Organisation ist bereits endgültig gelöscht; die Löschung lässt sich nicht mehr abbrechen.',
      });
    }
    const run = await this.retention.runJob(
      {
        category: 'user_accounts',
        run: async (ctx) => {
          for (const id of ids) {
            if (await restoreOrganization(ctx.manager, id, ctx.now)) {
              ctx.note('organizationsRestored', 1);
            }
          }
          await ctx.manager.query(
            `UPDATE retention_notices SET cancelled_at = $2, cancel_reason = 'cancelled'
              WHERE subject_type = 'user' AND subject_id = $1
                AND kind = 'account_deletion'
                AND executed_at IS NULL AND cancelled_at IS NULL`,
            [user.id, ctx.now],
          );
          await ctx.manager.query(
            `UPDATE users SET deletion_due_at = NULL WHERE id = $1`,
            [user.id],
          );
          ctx.note('accountDeletionsCancelled', 1);
        },
      },
      {
        trigger: 'self_service',
        dryRun: false,
        executedByUserId: user.id,
        reason: 'Löschung des Kontos abgebrochen',
        details: { organizationIds: ids },
      },
    );
    if (run.status !== 'succeeded') {
      throw new InternalServerErrorException({
        code: ErrorCodes.INTERNAL_ERROR,
        message:
          'Die Löschung konnte gerade nicht abgebrochen werden. Versuch es bitte später noch einmal.',
      });
    }
    return run;
  }
}
