import { Injectable, Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { EmailService } from '../email/email.service';
import type {
  RetentionNoticeKind,
  RetentionNoticeSubject,
} from '../../database/entities';
import type { RetentionMail } from './retention-mails';
import { select } from './retention-sql';

export interface OpenNotice {
  id: string;
  subject_id: string;
  sent_at: Date;
  due_at: Date;
  activity_at: Date | null;
}

/**
 * Ankuendigungen vor Schliessung und endgueltiger Loeschung: Empfaenger
 * ermitteln, Mail senden, Ankuendigung festhalten. Festgehalten wird nur,
 * was mindestens einen Empfaenger erreicht hat (oder wenn es keinen gibt);
 * scheitert der Versand, versucht es der naechste Lauf erneut.
 */
@Injectable()
export class RetentionNoticeService {
  private readonly logger = new Logger(RetentionNoticeService.name);

  constructor(private readonly emailService: EmailService) {}

  get appUrl(): string {
    return this.emailService.appUrl;
  }

  /** Administratoren einer Organisation (auch einer geloeschten). */
  async organizationRecipients(
    manager: EntityManager,
    organizationId: string,
  ): Promise<string[]> {
    const rows = await select<{ email: string }>(
      manager,
      `SELECT DISTINCT u.email FROM user_organizations uo
         JOIN users u ON u.id = uo.user_id
        WHERE uo.organization_id = $1 AND uo.role = 'admin'
          AND u.deleted_at IS NULL AND u.is_active = true`,
      [organizationId],
    );
    if (rows.length > 0) return rows.map((r) => r.email);
    const billing = await select<{ billing_email: string | null }>(
      manager,
      `SELECT billing_email FROM organizations WHERE id = $1`,
      [organizationId],
    );
    return billing[0]?.billing_email ? [billing[0].billing_email] : [];
  }

  async openNotices(
    manager: EntityManager,
    subjectType: RetentionNoticeSubject,
    kind: RetentionNoticeKind,
  ): Promise<OpenNotice[]> {
    return select<OpenNotice>(
      manager,
      `SELECT id, subject_id, sent_at, due_at, activity_at FROM retention_notices
        WHERE subject_type = $1 AND kind = $2
          AND executed_at IS NULL AND cancelled_at IS NULL`,
      [subjectType, kind],
    );
  }

  /**
   * Sendet die Mail an alle Empfaenger und haelt die Ankuendigung fest.
   * Liefert `false`, wenn kein Versand gelang (dann nichts festgehalten).
   */
  async send(
    manager: EntityManager,
    notice: {
      subjectType: RetentionNoticeSubject;
      subjectId: string;
      kind: RetentionNoticeKind;
      now: Date;
      dueAt: Date;
      activityAt: Date | null;
    },
    recipients: string[],
    compose: (to: string) => RetentionMail,
  ): Promise<{ recorded: boolean; delivered: number }> {
    const delivered = await this.deliver(
      recipients,
      compose,
      `Notice ${notice.kind} ${notice.subjectId}`,
    );
    if (recipients.length > 0 && delivered === 0) {
      return { recorded: false, delivered };
    }
    await manager.query(
      `INSERT INTO retention_notices
         (subject_type, subject_id, kind, sent_at, recipient_count, due_at, activity_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        notice.subjectType,
        notice.subjectId,
        notice.kind,
        notice.now,
        delivered,
        notice.dueAt,
        notice.activityAt,
      ],
    );
    return { recorded: true, delivered };
  }

  /** Sendet eine Mail je Empfaenger; liefert die Anzahl der Zustellungen. */
  async deliver(
    recipients: string[],
    compose: (to: string) => RetentionMail,
    label: string,
  ): Promise<number> {
    let delivered = 0;
    for (const to of recipients) {
      const mail = compose(to);
      try {
        if (
          await this.emailService.sendEmail({
            to,
            subject: mail.subject,
            html: mail.html,
            text: mail.text,
          })
        ) {
          delivered++;
        }
      } catch (error) {
        this.logger.warn(
          `${label}: send failed (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    return delivered;
  }

  async cancel(
    manager: EntityManager,
    id: string,
    now: Date,
    reason: string,
  ): Promise<void> {
    await manager.query(
      `UPDATE retention_notices SET cancelled_at = $2, cancel_reason = $3
        WHERE id = $1 AND executed_at IS NULL AND cancelled_at IS NULL`,
      [id, now, reason],
    );
  }

  async markExecuted(
    manager: EntityManager,
    id: string,
    now: Date,
  ): Promise<void> {
    await manager.query(
      `UPDATE retention_notices SET executed_at = $2 WHERE id = $1`,
      [id, now],
    );
  }
}
