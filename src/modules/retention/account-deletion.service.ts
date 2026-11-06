import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';

import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { EncryptionService } from '../../common/services/encryption.service';
import type { RetentionRun } from '../../database/entities';
import type { UserAccountsJob } from './jobs/user-accounts.job';
import { accountDeletedMail, accountDeletionCodeMail } from './retention-mails';
import { RetentionNoticeService } from './retention-notice.service';
import { affected } from './retention-sql';
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
   * ist: sie werden mit dem Konto geloescht (Exportfrist, dann endgueltig).
   */
  closesOrganizations: Array<{ organizationId: string; name: string }>;
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
      `SELECT id, email, password_hash, is_superadmin FROM users
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
    return {
      allowed:
        !user.is_superadmin && blockers.length === 0 && !unclosedTransactions,
      confirmation: user.password_hash ? 'password' : 'email_code',
      superAdmin: user.is_superadmin,
      unclosedTransactions,
      blockers,
      closesOrganizations,
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
   * Loescht (anonymisiert) das Konto nach Bestaetigung. Liefert den
   * Protokolleintrag; die Bestaetigungsmail geht an die bisherige Adresse.
   */
  async deleteAccount(
    userId: string,
    confirmation: { password?: string; code?: string },
  ): Promise<RetentionRun> {
    const user = await this.user(userId);
    const status = await this.status(userId);
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

    const job = this.userJob;
    const closes = status.closesOrganizations.map((o) => o.organizationId);
    const run = await this.retention.runJob(
      {
        category: 'user_accounts',
        run: async (ctx) => {
          if (closes.length > 0) {
            ctx.removed(
              'organizationsClosed',
              await affected(
                ctx.manager,
                `UPDATE organizations SET deleted_at = $2
                  WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
                [closes, ctx.now],
              ),
            );
          }
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
          closedOrganizations: status.closesOrganizations.map((o) => o.name),
        }),
      `Account deleted ${user.id}`,
    );
    return run;
  }
}
