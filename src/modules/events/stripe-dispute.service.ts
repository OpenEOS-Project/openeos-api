import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type Stripe from 'stripe';

import { Event } from '../../database/entities/event.entity';
import { Organization } from '../../database/entities/organization.entity';
import { AdminAction } from '../../database/entities/admin-audit-log.entity';
import { StripeService } from '../stripe/stripe.service';
import { EmailService } from '../email/email.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { BillingAuditService } from './billing-audit.service';

/** Stripes Rueckbuchungsgruende, so dass der Betreiber sie ohne Nachschlagen versteht. */
const DISPUTE_REASONS: Record<string, string> = {
  bank_cannot_process: 'Bank kann nicht verarbeiten',
  credit_not_processed: 'Gutschrift nicht erhalten',
  customer_initiated: 'vom Kunden veranlasst',
  debit_not_authorized: 'Lastschrift nicht autorisiert',
  duplicate: 'doppelt belastet',
  fraudulent: 'Betrug / nicht autorisiert',
  general: 'allgemein',
  incorrect_account_details: 'falsche Kontodaten',
  insufficient_funds: 'keine Deckung',
  noncompliant: 'Regelverstoß',
  product_not_received: 'Leistung nicht erhalten',
  product_unacceptable: 'Leistung mangelhaft',
  subscription_canceled: 'Abo gekündigt',
  unrecognized: 'Zahlung nicht erkannt',
};

const DISPUTE_STATUS: Record<string, string> = {
  won: 'gewonnen – der Betrag bleibt bei uns',
  lost: 'verloren – Betrag und Gebühr sind zurückgebucht',
  warning_closed: 'Vorwarnung geschlossen – keine Rückbuchung',
  prevented: 'abgewendet',
  needs_response: 'Antwort erforderlich',
  under_review: 'in Prüfung',
  warning_needs_response: 'Vorwarnung – Antwort erforderlich',
  warning_under_review: 'Vorwarnung – in Prüfung',
};

export function disputeReasonLabel(reason: string): string {
  const label = DISPUTE_REASONS[reason];
  return label ? `${label} (${reason})` : reason;
}

function idOf(
  value: string | { id: string } | null | undefined,
): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

/**
 * Rueckbuchungen (Disputes) zu bezahlten Freischaltungen.
 *
 * Stripe meldet `charge.dispute.created`, sobald der Karteninhaber oder
 * die Bank eine Zahlung anficht, und `charge.dispute.closed` mit dem
 * Ergebnis. Beides geht als Warnung an den Betreiber (Adresse aus den
 * Super-Admin-Einstellungen, ohne Schalter — eine Rueckbuchung muss jemand
 * sehen) und ins Admin-Protokoll.
 *
 * Bewusst keine automatische Sperre der Veranstaltung: eine Rueckbuchung
 * ist oft ein Missverstaendnis (Abbuchung nicht erkannt), und eine mitten
 * im Fest gesperrte Kasse waere der groessere Schaden. Ob und wie reagiert
 * wird, entscheidet der Betreiber.
 */
@Injectable()
export class StripeDisputeService {
  private readonly logger = new Logger(StripeDisputeService.name);

  constructor(
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    private readonly stripeService: StripeService,
    private readonly emailService: EmailService,
    private readonly platformSettingsService: PlatformSettingsService,
    private readonly billingAudit: BillingAuditService,
  ) {}

  async handleDispute(
    dispute: Stripe.Dispute,
    phase: 'created' | 'closed',
    stripeEventId: string,
  ): Promise<void> {
    const action =
      phase === 'created'
        ? AdminAction.EVENT_PAYMENT_DISPUTE_OPENED
        : AdminAction.EVENT_PAYMENT_DISPUTE_CLOSED;

    // Stripe stellt mindestens einmal zu — je Ereignis nur eine Warnung.
    if (
      await this.billingAudit.hasEntryWithDetail(
        action,
        'stripeEventId',
        stripeEventId,
      )
    ) {
      return;
    }

    const paymentIntentId = idOf(dispute.payment_intent);
    let metadata: Record<string, string> = {};
    if (paymentIntentId) {
      try {
        const intent =
          dispute.payment_intent && typeof dispute.payment_intent !== 'string'
            ? dispute.payment_intent
            : await this.stripeService.getPaymentIntent(paymentIntentId);
        metadata = intent.metadata ?? {};
      } catch (error) {
        this.logger.warn(
          `Zahlung ${paymentIntentId} zur Rückbuchung ${dispute.id} nicht abrufbar: ${(error as Error).message}`,
        );
      }
    }

    const event = metadata.eventId
      ? await this.eventRepository.findOne({
          where: { id: metadata.eventId },
          withDeleted: true,
        })
      : null;
    const organizationId = event?.organizationId ?? metadata.organizationId;
    const organization = organizationId
      ? await this.organizationRepository.findOne({
          where: { id: organizationId },
        })
      : null;

    const currency = (dispute.currency ?? 'eur').toUpperCase();
    const amount = (dispute.amount ?? 0) / 100;
    const dueBy = dispute.evidence_details?.due_by
      ? new Date(dispute.evidence_details.due_by * 1000)
      : null;

    this.logger.warn(
      `Rückbuchung ${dispute.id} ${phase} (${dispute.status}): ${amount} ${currency}, ` +
        `event=${event?.id ?? '-'} org=${organizationId ?? '-'} reason=${dispute.reason}`,
    );

    await this.billingAudit.record({
      action,
      organizationId: organization?.id ?? null,
      eventId: event?.id ?? null,
      details: {
        stripeEventId,
        disputeId: dispute.id,
        paymentIntentId,
        chargeId: idOf(dispute.charge),
        amount,
        currency,
        reason: dispute.reason,
        status: dispute.status,
        evidenceDueBy: dueBy ? dueBy.toISOString() : null,
      },
    });

    try {
      const to = await this.platformSettingsService.resolvePlatformAdminEmail();
      if (!to) {
        this.logger.warn(
          `Rückbuchung ${dispute.id}: keine Betreiber-Adresse konfiguriert`,
        );
        return;
      }
      const betrag = new Intl.NumberFormat('de-DE', {
        style: 'currency',
        currency,
      }).format(amount);
      const rows: [string, string][] = [
        ['Organisation', organization?.name ?? organizationId ?? 'unbekannt'],
        ['Veranstaltung', event?.name ?? metadata.eventId ?? 'unbekannt'],
        ['Betrag', betrag],
        ['Grund', disputeReasonLabel(dispute.reason)],
        ['Status', DISPUTE_STATUS[dispute.status] ?? dispute.status],
        ['Rückbuchung', dispute.id],
      ];
      if (paymentIntentId) rows.push(['Zahlung', paymentIntentId]);
      if (phase === 'created' && dueBy) {
        rows.push([
          'Nachweise bis',
          new Intl.DateTimeFormat('de-DE', {
            dateStyle: 'medium',
            timeStyle: 'short',
            timeZone: 'Europe/Berlin',
          }).format(dueBy),
        ]);
      }

      await this.emailService.sendAdminBillingAlert({
        to,
        subject:
          phase === 'created'
            ? `Rückbuchung eröffnet – ${betrag}`
            : `Rückbuchung abgeschlossen – ${DISPUTE_STATUS[dispute.status] ?? dispute.status}`,
        intro:
          phase === 'created'
            ? 'Eine Zahlung für eine Freischaltung wurde angefochten. Stripe hat den Betrag samt Gebühr vorläufig zurückgebucht. Die Veranstaltung wurde nicht gesperrt.'
            : 'Stripe hat eine Rückbuchung zu einer Freischaltung abgeschlossen.',
        rows,
        todo:
          phase === 'created'
            ? {
                title: 'Bitte im Stripe-Dashboard reagieren',
                text: 'Nachweise (Rechnung, Nutzung der Veranstaltung) fristgerecht einreichen oder die Rückbuchung akzeptieren. Bei Bedarf die Organisation kontaktieren.',
              }
            : null,
      });
    } catch (error) {
      this.logger.warn(
        `Warnung zur Rückbuchung ${dispute.id} nicht gesendet: ${(error as Error).message}`,
      );
    }
  }
}
