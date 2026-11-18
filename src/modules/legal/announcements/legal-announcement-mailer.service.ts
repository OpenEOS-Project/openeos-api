import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';

import { CronLockService } from '../../../common/redis/cron-lock.service';
import type { LegalDocumentKey } from '../../../config/legal.config';
import { EmailService } from '../../email/email.service';
import { LegalService } from '../legal.service';
import {
  type AnnouncementForMail,
  LegalAnnouncementsService,
} from './legal-announcements.service';

/** Mails je Lauf (ein Lauf je Minute und Instanz). */
export const ANNOUNCEMENT_BATCH_SIZE = 50;
/** Pause zwischen zwei Mails, schont den Mailserver. */
export const ANNOUNCEMENT_MAIL_PAUSE_MS = 250;
/**
 * So lange darf eine Mail als „wird gesendet“ stehen. Danach ist der
 * Versand abgebrochen (Neustart mitten im Senden) — ob sie rausging, weiss
 * niemand. Sie wird nicht von selbst wiederholt (lieber keine Mail als
 * zwei), sondern als gescheitert gezeigt; der Super-Admin entscheidet.
 */
export const ANNOUNCEMENT_STALE_MINUTES = 10;

const INTERRUPTED =
  'Versand unterbrochen (z. B. Neustart) – ob die Mail zugestellt wurde, ist unklar.';

interface ClaimedDelivery {
  id: string;
  announcement_id: string;
  email: string;
  first_name: string | null;
}

export interface MailRunSummary {
  sent: number;
  failed: number;
  interrupted: number;
}

/**
 * Versendet die Mails der Ankuendigungen (`legal_announcement_deliveries`).
 *
 * - Jede Minute ein Lauf (eine Instanz, CronLockService), dazu ein Anstoss
 *   direkt nach dem Anlegen einer Ankuendigung.
 * - Je Lauf hoechstens ANNOUNCEMENT_BATCH_SIZE Mails, mit Pause dazwischen.
 * - Vor dem Senden wird jede Zeile beansprucht (`pending` → `sending`, mit
 *   `FOR UPDATE SKIP LOCKED`): zwei Laeufe senden nie dieselbe Mail.
 *   Danach `sent` bzw. `failed`. Haengt eine Zeile in `sending` (Absturz),
 *   wird sie als gescheitert markiert statt erneut gesendet.
 * - Ohne eingerichteten Mailversand (`EMAIL_ENABLED`) bleibt alles in der
 *   Warteschlange, statt als „gesendet“ zu gelten.
 */
@Injectable()
export class LegalAnnouncementMailer {
  private readonly logger = new Logger(LegalAnnouncementMailer.name);
  private running = false;
  /** Austauschbar fuer Tests. */
  pauseMs = ANNOUNCEMENT_MAIL_PAUSE_MS;

  constructor(
    private readonly dataSource: DataSource,
    private readonly emailService: EmailService,
    private readonly legal: LegalService,
    private readonly announcements: LegalAnnouncementsService,
    private readonly cronLock: CronLockService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'legal-announcement-mails' })
  async scheduled(): Promise<void> {
    if (!this.legal.baseConfig.enabled || !this.emailService.enabled) return;
    await this.cronLock.runExclusive('legal-announcement-mails', async () => {
      await this.run();
    });
  }

  /** Sofort einen Lauf anstossen (nach dem Anlegen), ohne zu warten. */
  kick(): void {
    void this.run().catch((error: Error) =>
      this.logger.error(`Versand der Ankündigung: ${error.message}`),
    );
  }

  /** Ein Lauf auf dieser Instanz; laeuft schon einer, passiert nichts. */
  async run(
    limit: number = ANNOUNCEMENT_BATCH_SIZE,
  ): Promise<MailRunSummary | null> {
    if (this.running || !this.emailService.enabled) return null;
    this.running = true;
    try {
      return await this.processBatch(limit);
    } finally {
      this.running = false;
    }
  }

  async processBatch(limit: number): Promise<MailRunSummary> {
    const summary: MailRunSummary = { sent: 0, failed: 0, interrupted: 0 };

    const stale: [unknown[], number] = await this.dataSource.query(
      `UPDATE legal_announcement_deliveries
          SET status = 'failed', error = $1
        WHERE status = 'sending'
          AND claimed_at < now() - make_interval(mins => $2)`,
      [INTERRUPTED, ANNOUNCEMENT_STALE_MINUTES],
    );
    summary.interrupted = stale[1] ?? 0;
    if (summary.interrupted) {
      this.logger.warn(
        `${summary.interrupted} Ankündigungs-Mail(s) hingen im Versand und gelten als gescheitert.`,
      );
    }

    const [claimed]: [ClaimedDelivery[], number] = await this.dataSource.query(
      `UPDATE legal_announcement_deliveries d
          SET status = 'sending', claimed_at = now(), attempts = d.attempts + 1
        WHERE d.id IN (
          SELECT id FROM legal_announcement_deliveries
           WHERE status = 'pending'
           ORDER BY created_at, id
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING d.id, d.announcement_id, d.email, d.first_name`,
      [limit],
    );
    if (!claimed?.length) return summary;

    const cache = new Map<string, AnnouncementForMail | null>();
    for (const [index, delivery] of claimed.entries()) {
      if (index > 0 && this.pauseMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.pauseMs));
      }
      let error: string | null = null;
      try {
        const announcement = await this.announcementFor(
          delivery.announcement_id,
          cache,
        );
        if (!announcement) throw new Error('Ankündigung nicht gefunden');
        const mail = this.announcements.renderMail(announcement, {
          email: delivery.email,
          firstName: delivery.first_name,
        });
        const ok = await this.emailService.sendEmail({
          to: delivery.email,
          subject: mail.subject,
          html: mail.html,
          replyTo: this.announcements.contactEmail,
        });
        if (!ok) error = 'Mailserver hat die Mail nicht angenommen.';
      } catch (e) {
        error = (e as Error).message || 'Unbekannter Fehler';
      }

      if (error) {
        summary.failed++;
        await this.dataSource.query(
          `UPDATE legal_announcement_deliveries
              SET status = 'failed', error = $2
            WHERE id = $1 AND status = 'sending'`,
          [delivery.id, error.slice(0, 500)],
        );
      } else {
        summary.sent++;
        await this.dataSource.query(
          `UPDATE legal_announcement_deliveries
              SET status = 'sent', sent_at = now(), error = NULL
            WHERE id = $1 AND status = 'sending'`,
          [delivery.id],
        );
      }
    }
    this.logger.log(
      `Ankündigung Rechtstexte: ${summary.sent} gesendet, ${summary.failed} gescheitert`,
    );
    return summary;
  }

  private async announcementFor(
    id: string,
    cache: Map<string, AnnouncementForMail | null>,
  ): Promise<AnnouncementForMail | null> {
    if (cache.has(id)) return cache.get(id)!;
    const [row]: {
      documents: LegalDocumentKey[];
      version: string;
      previous_versions: Partial<Record<LegalDocumentKey, string>>;
      summary_de: string;
      summary_en: string | null;
      short_notice: boolean;
      explicit_consent: boolean;
    }[] = await this.dataSource.query(
      `SELECT documents, version, previous_versions, summary_de, summary_en,
              short_notice, explicit_consent
         FROM legal_announcements WHERE id = $1`,
      [id],
    );
    const announcement = row
      ? {
          documents: row.documents,
          version: row.version,
          previousVersions: row.previous_versions ?? {},
          summaryDe: row.summary_de,
          summaryEn: row.summary_en,
          shortNotice: row.short_notice,
          explicitConsent: row.explicit_consent,
        }
      : null;
    cache.set(id, announcement);
    return announcement;
  }
}
