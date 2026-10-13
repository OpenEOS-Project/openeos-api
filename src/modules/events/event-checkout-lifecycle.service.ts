import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import type Stripe from 'stripe';

import { Event } from '../../database/entities/event.entity';
import { Organization } from '../../database/entities/organization.entity';
import {
  OrganizationRole,
  UserOrganization,
} from '../../database/entities/user-organization.entity';
import { AdminAction } from '../../database/entities/admin-audit-log.entity';
import { CronLockService } from '../../common/redis/cron-lock.service';
import { StripeService } from '../stripe/stripe.service';
import { EmailService } from '../email/email.service';
import { EventBillingService } from './event-billing.service';
import { BillingAuditService } from './billing-audit.service';

/**
 * Warum eine begonnene Zahlung verworfen wurde.
 * - `expired`: Zahlungsseite abgelaufen (oder von uns geschlossen),
 * - `payment_failed`: Lastschrift nicht eingeloest,
 * - `missing`: Stripe kennt die Sitzung nicht (mehr) bzw. es gibt keine.
 */
export type CheckoutReleaseReason = 'expired' | 'payment_failed' | 'missing';

/**
 * Ab wann eine Freischaltung "haengt". Stripe-Zahlungsseiten laufen nach
 * hoechstens 24 Stunden ab; eine Stunde Luft fuer verspaetete Webhooks.
 */
export const STALE_CHECKOUT_AFTER_MS = 25 * 60 * 60 * 1000;

/**
 * Der Aufraeumjob benachrichtigt nur, wenn die Zahlungsseite in diesem
 * Zeitraum begonnen wurde. Aeltere Altfaelle werden still (nur mit
 * Protokolleintrag) zurueckgesetzt — eine Mail Wochen spaeter verwirrt
 * mehr, als sie hilft.
 */
export const CLEANUP_NOTIFY_WINDOW_MS = 72 * 60 * 60 * 1000;

export type CheckoutReconcileOutcome = 'settled' | 'released' | 'kept';

export interface CheckoutCleanupSummary {
  checked: number;
  settled: number;
  released: number;
  kept: number;
  failed: number;
}

/**
 * Was mit einer begonnenen, aber nicht bezahlten Freischaltung geschieht.
 *
 * Beim Oeffnen der Zahlungsseite steht die Veranstaltung auf `pending`.
 * Kommt keine Zahlung zustande, muss sie zurueck auf `none` — sonst haengt
 * sie im Zustand "Zahlung laeuft", und die Oberflaeche bietet das
 * Freischalten nicht mehr an.
 *
 * Zwei Wege fuehren dorthin:
 * - Webhooks `checkout.session.expired` (Zahlungsseite abgelaufen) und
 *   `checkout.session.async_payment_failed` (Lastschrift geplatzt),
 * - ein stuendlicher Abgleich mit Stripe fuer alles, was ohne Webhook
 *   haengen geblieben ist (Altfaelle, verlorene Zustellungen).
 *
 * Zurueckgesetzt wird nur mit bedingtem Update auf genau diese Sitzung:
 * gehoert die Veranstaltung inzwischen zu einer neueren Zahlungsseite oder
 * ist sie schon bezahlt, bleibt alles, wie es ist. Das macht beide Wege
 * idempotent — eine wiederholte Zustellung findet nichts mehr zu tun und
 * verschickt keine zweite Mail.
 *
 * Reihenfolge bei Stripe: eine abgeschlossene Sitzung laeuft nie ab, und
 * `async_payment_succeeded`/`_failed` folgen nur auf `completed`. Kommt
 * nach dem Zuruecksetzen trotzdem noch eine Erfolgsmeldung (z. B. eine
 * verspaetete Lastschrift einer frueheren Seite), verbucht
 * `settleStripePayment` sie ganz normal: es fragt Stripe nach dem Stand und
 * schaltet frei, wenn bezahlt ist — kein Geld geht verloren.
 */
@Injectable()
export class EventCheckoutLifecycleService {
  private readonly logger = new Logger(EventCheckoutLifecycleService.name);

  constructor(
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    private readonly stripeService: StripeService,
    private readonly eventBillingService: EventBillingService,
    private readonly emailService: EmailService,
    private readonly billingAudit: BillingAuditService,
    private readonly cronLock: CronLockService,
  ) {}

  /** Webhook `checkout.session.expired`. */
  async handleCheckoutExpired(
    session: Stripe.Checkout.Session,
    stripeEventId: string | null = null,
  ): Promise<boolean> {
    return this.release({
      sessionId: session.id,
      eventId: session.metadata?.eventId ?? null,
      reason: 'expired',
      failureReason: null,
      notify: true,
      source: 'webhook',
      stripeEventId,
    });
  }

  /** Webhook `checkout.session.async_payment_failed` (Lastschrift). */
  async handleAsyncPaymentFailed(
    session: Stripe.Checkout.Session,
    stripeEventId: string | null = null,
  ): Promise<boolean> {
    let failureReason: string | null = null;
    try {
      const full = await this.stripeService.getCheckoutSessionWithPayment(
        session.id,
      );
      failureReason = this.failureReasonOf(full);
    } catch (error) {
      // Der Grund ist nur ein Zusatz — ohne ihn wird trotzdem zurueckgesetzt.
      this.logger.warn(
        `Grund der gescheiterten Zahlung ${session.id} nicht abrufbar: ${(error as Error).message}`,
      );
    }
    return this.release({
      sessionId: session.id,
      eventId: session.metadata?.eventId ?? null,
      reason: 'payment_failed',
      failureReason,
      notify: true,
      source: 'webhook',
      stripeEventId,
    });
  }

  /** Was die Bank zur gescheiterten Lastschrift sagt, falls Stripe es weiss. */
  private failureReasonOf(session: Stripe.Checkout.Session): string | null {
    const intent =
      session.payment_intent && typeof session.payment_intent !== 'string'
        ? session.payment_intent
        : null;
    if (!intent) return null;
    const charge =
      intent.latest_charge && typeof intent.latest_charge !== 'string'
        ? intent.latest_charge
        : null;
    return (
      charge?.failure_message ||
      intent.last_payment_error?.message ||
      charge?.failure_code ||
      intent.last_payment_error?.code ||
      null
    );
  }

  /**
   * Setzt die Veranstaltung von `pending` (mit genau dieser Sitzung)
   * zurueck auf `none`. Nur wer die Zeile tatsaechlich aendert, schreibt
   * ins Protokoll und benachrichtigt.
   */
  async release(params: {
    sessionId: string | null;
    eventId: string | null;
    reason: CheckoutReleaseReason;
    failureReason: string | null;
    notify: boolean;
    source: 'webhook' | 'cleanup';
    stripeEventId?: string | null;
  }): Promise<boolean> {
    const { sessionId } = params;
    const event = params.eventId
      ? await this.eventRepository.findOne({
          where: { id: params.eventId },
          withDeleted: true,
        })
      : sessionId
        ? await this.eventRepository.findOne({
            where: { stripeCheckoutSessionId: sessionId },
            withDeleted: true,
          })
        : null;
    if (!event) {
      this.logger.debug(
        `Checkout ${sessionId ?? '-'} gehört zu keiner bekannten Veranstaltung`,
      );
      return false;
    }

    const result = await this.eventRepository.update(
      {
        id: event.id,
        billingStatus: 'pending',
        stripeCheckoutSessionId: sessionId ?? IsNull(),
      },
      { billingStatus: 'none', stripeCheckoutSessionId: null },
    );
    if (!result.affected) {
      // Schon zurueckgesetzt, bezahlt oder inzwischen eine neuere Seite.
      this.logger.debug(
        `Checkout ${sessionId ?? '-'} (event ${event.id}): nichts zurückzusetzen`,
      );
      return false;
    }

    this.logger.log(
      `Freischaltung von Event ${event.id} zurückgesetzt: Checkout ${sessionId ?? '-'} ${params.reason} (${params.source})`,
    );

    await this.billingAudit.record({
      action: AdminAction.EVENT_CHECKOUT_RELEASED,
      organizationId: event.organizationId,
      eventId: event.id,
      details: {
        sessionId,
        reason: params.reason,
        source: params.source,
        failureReason: params.failureReason,
        stripeEventId: params.stripeEventId ?? null,
        before: {
          billingStatus: 'pending',
          stripeCheckoutSessionId: sessionId,
        },
        after: { billingStatus: 'none', stripeCheckoutSessionId: null },
      },
    });

    if (
      params.notify &&
      !event.deletedAt &&
      (params.reason === 'expired' || params.reason === 'payment_failed')
    ) {
      await this.notifyOrganization(event, params.reason, params.failureReason);
    }
    return true;
  }

  /**
   * An die Rechnungs-E-Mail, ohne eine solche an alle Administratoren der
   * Organisation. Best effort.
   */
  private async notifyOrganization(
    event: Event,
    reason: 'expired' | 'payment_failed',
    failureReason: string | null,
  ): Promise<void> {
    try {
      const organization = await this.organizationRepository.findOne({
        where: { id: event.organizationId },
      });
      const recipients = organization?.billingEmail
        ? [organization.billingEmail]
        : await this.adminEmails(event.organizationId);

      for (const to of recipients) {
        await this.emailService.sendEventCheckoutNotCompletedEmail({
          to,
          organizationName: organization?.name ?? '',
          eventName: event.name,
          eventDate: event.startDate,
          timeZone: organization?.settings?.timezone || 'Europe/Berlin',
          reason,
          failureReason,
        });
      }
    } catch (error) {
      this.logger.warn(
        `Hinweis "Zahlung nicht abgeschlossen" für Event ${event.id} nicht gesendet: ${(error as Error).message}`,
      );
    }
  }

  private async adminEmails(organizationId: string): Promise<string[]> {
    const memberships = await this.userOrganizationRepository.find({
      where: { organizationId, role: OrganizationRole.ADMIN },
      relations: ['user'],
    });
    const emails = memberships
      .map((m) => m.user?.email)
      .filter((email): email is string => !!email);
    return [...new Set(emails)];
  }

  /**
   * Stuendlich: haengende Freischaltungen mit Stripe abgleichen. Nur eine
   * API-Instanz fuehrt den Lauf aus (CronLockService).
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'stale-stripe-checkouts' })
  async handleStaleCheckouts(): Promise<void> {
    await this.cronLock.runExclusive('stale-stripe-checkouts', async () => {
      await this.cleanupStalePendingCheckouts();
    });
  }

  /**
   * Alle Veranstaltungen auf `pending` mit Stripe abgleichen.
   *
   * Entschieden wird nach Stripes Stand, nicht nach dem Alter allein —
   * eine Zahlung, deren Webhook verloren ging, wird hier verbucht statt
   * verworfen. Die 25 Stunden greifen nur, wo Stripe nichts (mehr) sagen
   * kann oder eine Seite ungewoehnlich lange offen ist; die wird dann erst
   * bei Stripe geschlossen, bevor zurueckgesetzt wird.
   */
  async cleanupStalePendingCheckouts(
    now: Date = new Date(),
  ): Promise<CheckoutCleanupSummary> {
    const summary: CheckoutCleanupSummary = {
      checked: 0,
      settled: 0,
      released: 0,
      kept: 0,
      failed: 0,
    };
    if (!this.stripeService.isConfigured) return summary;

    const pending = await this.eventRepository.find({
      where: { billingStatus: 'pending' },
      withDeleted: true,
    });

    for (const event of pending) {
      summary.checked += 1;
      try {
        const outcome = await this.reconcile(event, now);
        summary[outcome] += 1;
      } catch (error) {
        summary.failed += 1;
        this.logger.warn(
          `Abgleich der Freischaltung von Event ${event.id} fehlgeschlagen: ${(error as Error).message}`,
        );
      }
    }

    if (summary.checked > 0) {
      this.logger.log(
        `Offene Freischaltungen abgeglichen: ${JSON.stringify(summary)}`,
      );
    }
    return summary;
  }

  /** Eine haengende Freischaltung nach Stripes Stand aufloesen. */
  async reconcile(
    event: Event,
    now: Date = new Date(),
  ): Promise<CheckoutReconcileOutcome> {
    const staleBefore = now.getTime() - STALE_CHECKOUT_AFTER_MS;
    const lastTouched = new Date(event.updatedAt ?? event.createdAt).getTime();
    const sessionId = event.stripeCheckoutSessionId;

    const release = async (
      reason: CheckoutReleaseReason,
      notify: boolean,
      failureReason: string | null = null,
    ): Promise<CheckoutReconcileOutcome> =>
      (await this.release({
        sessionId,
        eventId: event.id,
        reason,
        failureReason,
        notify,
        source: 'cleanup',
      }))
        ? 'released'
        : 'kept';

    if (!sessionId) {
      // Ohne Sitzung kann nichts bezahlt werden.
      return lastTouched < staleBefore ? release('missing', false) : 'kept';
    }

    let session: Stripe.Checkout.Session;
    try {
      session =
        await this.stripeService.getCheckoutSessionWithPayment(sessionId);
    } catch (error) {
      if (this.stripeService.isResourceMissing(error)) {
        return lastTouched < staleBefore ? release('missing', false) : 'kept';
      }
      throw error;
    }

    if (
      session.payment_status === 'paid' ||
      session.payment_status === 'no_payment_required'
    ) {
      // Bezahlt, aber der Webhook kam nie an: jetzt verbuchen.
      await this.eventBillingService.settleStripePayment(session.id);
      return 'settled';
    }

    const startedAt = (session.created ?? 0) * 1000;
    const recent = startedAt >= now.getTime() - CLEANUP_NOTIFY_WINDOW_MS;

    if (session.status === 'expired') {
      return release('expired', recent);
    }

    if (session.status === 'complete') {
      /* Abgeschlossen, aber (noch) nicht bezahlt: Lastschrift unterwegs.
         Die kann Tage dauern — nur zuruecksetzen, wenn Stripe sie
         ausdruecklich als gescheitert fuehrt. */
      const intent =
        session.payment_intent && typeof session.payment_intent !== 'string'
          ? session.payment_intent
          : null;
      if (
        intent &&
        (intent.status === 'requires_payment_method' ||
          intent.status === 'canceled')
      ) {
        return release('payment_failed', recent, this.failureReasonOf(session));
      }
      return 'kept';
    }

    // Offen: nur wenn sie ungewoehnlich lange offen ist.
    if (startedAt >= staleBefore) return 'kept';
    try {
      const expired = await this.stripeService.expireCheckoutSession(
        session.id,
      );
      if (expired.status !== 'expired') return 'kept';
    } catch (error) {
      /* Schliessen gescheitert — vielleicht wurde gerade bezahlt. Beim
         naechsten Lauf erneut nachsehen statt zu raten. */
      this.logger.warn(
        `Zahlungsseite ${session.id} (event ${event.id}) nicht geschlossen: ${(error as Error).message}`,
      );
      return 'kept';
    }
    return release('expired', recent);
  }
}
