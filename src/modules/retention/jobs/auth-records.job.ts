import { daysBefore } from '../retention.config';
import { affected } from '../retention-sql';
import type { RetentionJob, RetentionRunContext } from '../retention.types';

/**
 * Was eine Anmeldung oder Bestaetigung nur kurz braucht, sobald es
 * abgelaufen ist: Sitzungen (Refresh-Tokens), Einmalcodes, Anmelde- und
 * Helfer-Links, vertrauenswuerdige Geraete, Links zum Zuruecksetzen des
 * Passworts und zur Aenderung der E-Mail-Adresse.
 *
 * Ein Tag Puffer nach Ablauf, damit Mengenbegrenzungen, die juengste
 * Eintraege zaehlen, nicht ins Leere laufen. Erledigte bzw. abgelaufene
 * Einladungen und widerrufene oder abgelaufene API-Tokens verschwinden nach
 * `RETENTION_STALE_CREDENTIAL_DAYS` (90) Tagen.
 */
export class AuthRecordsJob implements RetentionJob {
  readonly category = 'auth_records' as const;

  async run(ctx: RetentionRunContext): Promise<void> {
    const { manager, now } = ctx;
    const expired = daysBefore(now, 1);
    const stale = daysBefore(now, ctx.config.staleCredentialDays);

    ctx.removed(
      'sessionsDeleted',
      await affected(
        manager,
        `DELETE FROM refresh_tokens
          WHERE expires_at < $1 OR (revoked_at IS NOT NULL AND revoked_at < $1)`,
        [expired],
      ),
    );
    ctx.removed(
      'oneTimeCodesDeleted',
      await affected(manager, `DELETE FROM email_otps WHERE expires_at < $1`, [
        expired,
      ]),
    );
    ctx.removed(
      'loginLinksDeleted',
      await affected(
        manager,
        `DELETE FROM login_magic_links WHERE expires_at < $1`,
        [expired],
      ),
    );
    ctx.removed(
      'helperLinksDeleted',
      await affected(
        manager,
        `DELETE FROM helper_magic_links WHERE expires_at < $1`,
        [expired],
      ),
    );
    ctx.removed(
      'trustedDevicesDeleted',
      await affected(
        manager,
        `DELETE FROM trusted_devices WHERE expires_at < $1`,
        [now],
      ),
    );
    ctx.removed(
      'passwordResetLinksCleared',
      await affected(
        manager,
        `UPDATE users SET password_reset_token = NULL, password_reset_expires_at = NULL
          WHERE password_reset_expires_at < $1`,
        [expired],
      ),
    );
    ctx.removed(
      'emailChangeRequestsCleared',
      await affected(
        manager,
        `UPDATE users SET pending_email = NULL, pending_email_token = NULL,
                pending_email_expires_at = NULL
          WHERE pending_email_expires_at < $1`,
        [expired],
      ),
    );
    ctx.removed(
      'invitationsDeleted',
      await affected(
        manager,
        `DELETE FROM invitations
          WHERE (accepted_at IS NOT NULL AND accepted_at < $1)
             OR (accepted_at IS NULL AND expires_at < $1)`,
        [stale],
      ),
    );
    ctx.removed(
      'apiTokensDeleted',
      await affected(
        manager,
        `DELETE FROM api_tokens
          WHERE (revoked_at IS NOT NULL AND revoked_at < $1)
             OR (expires_at IS NOT NULL AND expires_at < $1)`,
        [stale],
      ),
    );
  }
}
