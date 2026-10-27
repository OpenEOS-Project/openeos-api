import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  AdminAction,
  AdminAuditLog,
  SYSTEM_AUDIT_IP,
} from '../../database/entities/admin-audit-log.entity';

/** Wer eine Aenderung angestossen hat — fehlt er, war es das System. */
export interface AuditActor {
  userId: string;
  ipAddress: string;
  userAgent?: string | null;
}

/**
 * Schreibt Abrechnungsvorgaenge ins Admin-Protokoll (`admin_audit_logs`),
 * damit der Betreiber sie dort neben den uebrigen Eingriffen sieht.
 *
 * Vom System ausgeloeste Eintraege (Stripe-Webhook, Aufraeumjob) haben
 * keinen Admin; sie tragen `admin_user_id = NULL` und als Adresse
 * `system`.
 *
 * Best effort: ein Protokolleintrag, der nicht geschrieben werden kann, darf
 * keinen verbuchten Vorgang zurueckdrehen. Er wird geloggt.
 */
@Injectable()
export class BillingAuditService {
  private readonly logger = new Logger(BillingAuditService.name);

  constructor(
    @InjectRepository(AdminAuditLog)
    private readonly auditLogRepository: Repository<AdminAuditLog>,
  ) {}

  async record(entry: {
    action: AdminAction;
    organizationId: string | null;
    eventId: string | null;
    details: Record<string, unknown>;
    reason?: string | null;
    actor?: AuditActor | null;
  }): Promise<void> {
    try {
      const log = this.auditLogRepository.create({
        adminUserId: entry.actor?.userId ?? null,
        organizationId: entry.organizationId,
        action: entry.action,
        resourceType: 'event',
        resourceId: entry.eventId,
        details: entry.details,
        reason: entry.reason ?? null,
        ipAddress: (entry.actor?.ipAddress || SYSTEM_AUDIT_IP).slice(0, 45),
        userAgent: entry.actor?.userAgent?.slice(0, 500) ?? null,
      });
      await this.auditLogRepository.save(log);
    } catch (error) {
      this.logger.error(
        `Protokolleintrag ${entry.action} (event ${entry.eventId ?? '-'}) nicht geschrieben: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Gibt es schon einen Eintrag mit diesem Detailwert? Stripe stellt
   * Webhooks mindestens einmal zu; dieselbe Ereignis-ID kommt bei einer
   * Wiederholung erneut. So bleibt es bei einer Mail je Ereignis.
   */
  async hasEntryWithDetail(
    action: AdminAction,
    key: 'stripeEventId' | 'sessionId' | 'invoiceId' | 'creditNoteId',
    value: string,
  ): Promise<boolean> {
    const count = await this.auditLogRepository
      .createQueryBuilder('log')
      .where('log.action = :action', { action })
      .andWhere(`log.details ->> '${key}' = :value`, { value })
      .getCount();
    return count > 0;
  }
}
