import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import type Stripe from 'stripe';

import {
  Event,
  EventStatus,
  EVENT_PAID_BILLING_STATUSES,
} from '../../database/entities/event.entity';
import { Organization } from '../../database/entities/organization.entity';
import { Order } from '../../database/entities/order.entity';
import {
  EventBillingCancellation,
  EventBillingCancellationInitiator,
  EventRefundStatus,
} from '../../database/entities/event-billing-cancellation.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { User } from '../../database/entities';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { shiftCalendarDaysInZone } from '../../common/utils/event-schedule.util';
import { OrganizationsService } from '../organizations/organizations.service';
import { StripeService } from '../stripe/stripe.service';
import { EmailService } from '../email/email.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { GatewayService } from '../gateway/gateway.service';

/** Bis so viele Kalendertage vor Beginn ist der Storno kostenlos. */
export const FREE_CANCELLATION_DAYS = 7;

/** Warum gerade nicht storniert werden kann. */
export type CancellationBlock =
  | 'not_paid'
  | 'deadline_passed'
  | 'has_orders'
  | 'online_refund_unavailable';

export interface CancellationInfo {
  allowed: boolean;
  /** ISO-Zeitpunkt, bis zu dem kostenlos storniert werden kann. */
  deadline: string | null;
  /** Zeitzone der Organisation — die Oberflaeche zeigt die Frist darin. */
  timezone: string;
  blockedReason: CancellationBlock | null;
}

/** Was Oberflaeche und Antworten von einer Stornierung zu sehen bekommen. */
export interface CancellationSummary {
  id: string;
  cancelledAt: string;
  amount: number;
  currency: string;
  previousBillingStatus: 'paid' | 'invoice';
  refundStatus: EventRefundStatus | null;
  creditNoteNumber: string | null;
}

/** Ergebnis der Stripe-Seite eines Stornos. */
interface StripeRefundOutcome {
  stripePaymentIntentId: string | null;
  stripeInvoiceId: string | null;
  stripeCreditNoteId: string | null;
  creditNoteNumber: string | null;
  stripeRefundId: string | null;
  refundStatus: EventRefundStatus | null;
}

const DEFAULT_TIMEZONE = 'Europe/Berlin';

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Stornofrist einer Freischaltung: dieselbe Uhrzeit, sieben Kalendertage
 * vor Beginn, in der Zeitzone der Organisation.
 *
 * Bewusst Kalendertage statt 7 × 24 Stunden: liegt eine Zeitumstellung
 * dazwischen, waere die Frist sonst eine Stunde verrutscht und stuende als
 * "16:00" neben einem Beginn um 17 Uhr.
 *
 * Maßgeblich ist der fruehere von zwei Zeitpunkten — der Beginn beim
 * Freischalten und der heutige. Sonst liesse sich eine abgelaufene Frist
 * wieder oeffnen, indem man die Veranstaltung nach hinten schiebt.
 * Vorverlegen dagegen zieht die Frist mit nach vorn.
 */
export function cancellationDeadline(
  event: Pick<Event, 'startDate'> & { unlockedStartDate?: Date | null },
  timeZone: string,
): Date | null {
  const starts = [event.startDate, event.unlockedStartDate]
    .filter((value): value is Date => !!value)
    .map(toDate)
    .filter((date) => !Number.isNaN(date.getTime()));
  if (starts.length === 0) return null;
  const earliest = new Date(Math.min(...starts.map((d) => d.getTime())));
  return shiftCalendarDaysInZone(earliest, -FREE_CANCELLATION_DAYS, timeZone);
}

export function toCancellationSummary(
  record: EventBillingCancellation,
): CancellationSummary {
  return {
    id: record.id,
    cancelledAt: toDate(record.createdAt).toISOString(),
    amount: Number(record.amount),
    currency: record.currency,
    previousBillingStatus: record.previousBillingStatus,
    refundStatus: record.refundStatus,
    creditNoteNumber: record.creditNoteNumber,
  };
}

function idOf(
  value: string | { id: string } | null | undefined,
): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

const KNOWN_REFUND_STATUSES: readonly EventRefundStatus[] = [
  'pending',
  'succeeded',
  'failed',
  'canceled',
  'requires_action',
];

function refundStatusOf(status: string | null | undefined): EventRefundStatus {
  return KNOWN_REFUND_STATUSES.includes(status as EventRefundStatus)
    ? (status as EventRefundStatus)
    : 'pending';
}

/**
 * Kostenloser Storno einer bezahlten Freischaltung.
 *
 * Regeln (Oberflaeche, Doku und AGB versprechen genau das):
 * - nur bezahlte (Stripe) oder auf Rechnung bestellte Freischaltungen,
 * - nur bis 7 Kalendertage vor Beginn (siehe cancellationDeadline) —
 *   die Plattform darf die Frist uebergehen,
 * - nur ohne echte Bestellungen; Testbestellungen zaehlen nicht,
 * - Stripe: volle Erstattung, bei einer Rechnung aus dem Checkout als
 *   Stripe-Gutschrift (Stornorechnung) mit Erstattung,
 * - Rechnung: keine Zahlung zurueck; war die Rechnung schon gestellt, muss
 *   der Betreiber die Stornorechnung stellen (sie liegt nicht in OpenEOS),
 * - danach "nicht freigeschaltet"; eine aktive Veranstaltung faellt in den
 *   Testmodus zurueck. Der Starterbonus ist wieder frei, weil
 *   hasBilledEventBefore nur bezahlte/bestellte Veranstaltungen zaehlt.
 */
@Injectable()
export class EventUnlockCancellationService {
  private readonly logger = new Logger(EventUnlockCancellationService.name);

  constructor(
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(EventBillingCancellation)
    private readonly cancellationRepository: Repository<EventBillingCancellation>,
    private readonly organizationsService: OrganizationsService,
    private readonly stripeService: StripeService,
    private readonly emailService: EmailService,
    private readonly platformSettingsService: PlatformSettingsService,
    private readonly gatewayService: GatewayService,
  ) {}

  private timezoneOf(organization: Organization | null): string {
    return organization?.settings?.timezone || DEFAULT_TIMEZONE;
  }

  /** Ob und bis wann storniert werden kann — fuer die Abrechnungsansicht. */
  async describe(
    event: Event,
    organization: Organization,
    now: Date = new Date(),
  ): Promise<CancellationInfo> {
    const timezone = this.timezoneOf(organization);
    const deadline = cancellationDeadline(event, timezone);
    const info = (
      blockedReason: CancellationBlock | null,
    ): CancellationInfo => ({
      allowed: blockedReason === null,
      deadline: deadline ? deadline.toISOString() : null,
      timezone,
      blockedReason,
    });

    if (!EVENT_PAID_BILLING_STATUSES.includes(event.billingStatus)) {
      return info('not_paid');
    }
    if (deadline && now.getTime() >= deadline.getTime()) {
      return info('deadline_passed');
    }
    const orders = await this.orderRepository.count({
      where: { eventId: event.id, isTest: false },
    });
    if (orders > 0) return info('has_orders');
    if (
      event.billingStatus === 'paid' &&
      (!this.stripeService.isConfigured || !event.stripeCheckoutSessionId)
    ) {
      return info('online_refund_unavailable');
    }
    return info(null);
  }

  async lastCancellation(eventId: string): Promise<CancellationSummary | null> {
    const record = await this.cancellationRepository.findOne({
      where: { eventId },
      order: { createdAt: 'DESC' },
    });
    return record ? toCancellationSummary(record) : null;
  }

  /** Wurde die Freischaltung aus dieser Checkout-Sitzung schon storniert? */
  async wasCheckoutCancelled(sessionId: string): Promise<boolean> {
    const count = await this.cancellationRepository.count({
      where: { stripeCheckoutSessionId: sessionId },
    });
    return count > 0;
  }

  /** Storno durch die Organisation: nur Administratoren, mit Frist. */
  async cancelForOrganization(
    organizationId: string,
    eventId: string,
    user: User,
    now: Date = new Date(),
  ): Promise<EventBillingCancellation> {
    await this.organizationsService.checkRole(
      organizationId,
      user,
      OrganizationRole.ADMIN,
    );
    return this.cancel({
      eventId,
      organizationId,
      actor: user,
      initiatedBy: 'organization',
      enforceDeadline: true,
      now,
    });
  }

  /**
   * Storno durch die Plattform (Super-Admin): ohne Frist. Echte
   * Bestellungen verhindern ihn trotzdem — eine genutzte Veranstaltung
   * zu erstatten ist Kulanz und gehoert nicht in diesen Weg.
   */
  async cancelForPlatform(
    eventId: string,
    admin: User,
    now: Date = new Date(),
  ): Promise<EventBillingCancellation> {
    return this.cancel({
      eventId,
      organizationId: null,
      actor: admin,
      initiatedBy: 'platform',
      enforceDeadline: false,
      now,
    });
  }

  private async cancel(options: {
    eventId: string;
    organizationId: string | null;
    actor: User;
    initiatedBy: EventBillingCancellationInitiator;
    enforceDeadline: boolean;
    now: Date;
  }): Promise<EventBillingCancellation> {
    const {
      eventId,
      organizationId,
      actor,
      initiatedBy,
      enforceDeadline,
      now,
    } = options;

    /* Alles in einer Transaktion mit gesperrter Veranstaltungszeile: eine
       gleichzeitig angelegte Bestellung sperrt die Zeile geteilt und landet
       so entweder vor der Pruefung (dann wird abgelehnt) oder nach dem
       Storno (dann als Testbestellung). Zwei gleichzeitige Stornos
       erstatten nicht doppelt — der zweite sieht 'none' und bekommt die
       Stornierung des ersten zurueck.

       Stripe wird innerhalb der Transaktion gerufen. Schlaegt die
       Erstattung fehl, bleibt alles, wie es war. Scheitert dagegen erst der
       Commit, gibt ein Wiederholen dank Idempotenzschluessel dieselbe
       Erstattung zurueck statt einer zweiten. */
    const outcome = await this.eventRepository.manager.transaction(
      async (manager: EntityManager) => {
        await manager.query(`SELECT id FROM events WHERE id = $1 FOR UPDATE`, [
          eventId,
        ]);

        const events = manager.getRepository(Event);
        const event = await events.findOne({
          where: organizationId
            ? { id: eventId, organizationId }
            : { id: eventId },
        });
        if (!event) {
          throw new NotFoundException({
            code: ErrorCodes.NOT_FOUND,
            reason: ErrorReasons.EVENT_NOT_FOUND,
            message: 'Event nicht gefunden',
          });
        }
        const organization = await manager
          .getRepository(Organization)
          .findOne({ where: { id: event.organizationId } });

        const cancellations = manager.getRepository(EventBillingCancellation);

        if (!EVENT_PAID_BILLING_STATUSES.includes(event.billingStatus)) {
          /* Schon storniert: dieselbe Antwort noch einmal statt eines
             Fehlers. Ein Doppelklick oder eine nach einem Zeitlimit
             wiederholte Anfrage soll nicht wie ein Fehlschlag aussehen. */
          if (event.billingStatus === 'none') {
            const previous = await cancellations.findOne({
              where: { eventId: event.id },
              order: { createdAt: 'DESC' },
            });
            if (previous) {
              return {
                event,
                organization,
                cancellation: previous,
                replayed: true,
                statusChanged: false,
              };
            }
          }
          throw new BadRequestException({
            code: ErrorCodes.VALIDATION_ERROR,
            reason: ErrorReasons.EVENT_NOT_PAID,
            message: 'Die Veranstaltung ist nicht bezahlt freigeschaltet',
          });
        }

        const timezone = this.timezoneOf(organization);
        const deadline = cancellationDeadline(event, timezone);
        if (
          enforceDeadline &&
          deadline &&
          now.getTime() >= deadline.getTime()
        ) {
          throw new BadRequestException({
            code: ErrorCodes.VALIDATION_ERROR,
            reason: ErrorReasons.EVENT_CANCELLATION_DEADLINE_PASSED,
            message:
              'Die Frist für eine kostenlose Stornierung ist abgelaufen. Bitte wende dich an den Support.',
            params: { deadline: deadline.toISOString() },
          });
        }

        const orders = await manager.getRepository(Order).count({
          where: { eventId: event.id, isTest: false },
        });
        if (orders > 0) {
          throw new BadRequestException({
            code: ErrorCodes.VALIDATION_ERROR,
            reason: ErrorReasons.EVENT_HAS_ORDERS,
            message:
              'In der Veranstaltung gibt es schon Bestellungen — eine kostenlose Stornierung ist nicht mehr möglich',
            params: { orders },
          });
        }

        const previousBillingStatus = event.billingStatus as 'paid' | 'invoice';
        const record = cancellations.create({
          eventId: event.id,
          organizationId: event.organizationId,
          cancelledBy: actor.id,
          initiatedBy,
          previousBillingStatus,
          amount: Number(event.priceCharged ?? 0),
          currency: organization?.settings?.currency || 'EUR',
          paidAt: event.paidAt,
          billedDays: event.billedDays ?? null,
          deadline: enforceDeadline ? deadline : null,
          stripeCheckoutSessionId: event.stripeCheckoutSessionId,
          invoicedAt: event.invoicedAt,
          invoiceNote: event.invoiceNote,
          manualCreditNoteRequired:
            previousBillingStatus === 'invoice' && !!event.invoicedAt,
        });

        if (previousBillingStatus === 'paid') {
          Object.assign(record, await this.refundStripePayment(event));
        }

        const statusBefore = event.status;
        event.billingStatus = 'none';
        event.paidAt = null;
        event.priceCharged = null;
        event.billedDays = null;
        event.stripeCheckoutSessionId = null;
        event.unlockedStartDate = null;
        event.invoicedAt = null;
        event.invoicedBy = null;
        event.invoiceNote = null;
        // Aktiv heisst: es wird verkauft. Ohne Freischaltung geht das nur
        // noch im Testmodus.
        if (event.status === EventStatus.ACTIVE) {
          event.status = EventStatus.TEST;
        }
        await events.save(event);
        const saved = await cancellations.save(record);

        return {
          event,
          organization,
          cancellation: saved,
          replayed: false,
          statusChanged: statusBefore !== event.status,
        };
      },
    );

    if (outcome.replayed) return outcome.cancellation;

    const { event, organization, cancellation, statusChanged } = outcome;
    this.logger.log(
      `Freischaltung storniert: event=${event.id} org=${event.organizationId} ` +
        `by=${actor.id} (${initiatedBy}) amount=${cancellation.amount} ` +
        `via=${cancellation.previousBillingStatus} refund=${cancellation.stripeRefundId ?? '-'} ` +
        `creditNote=${cancellation.creditNoteNumber ?? '-'}`,
    );

    if (statusChanged) {
      this.gatewayService.notifyEventStatusChanged(event.organizationId, {
        eventId: event.id,
        organizationId: event.organizationId,
        status: event.status,
        name: event.name,
      });
    }

    await this.notifyCancelled(event, organization, cancellation, actor);
    return cancellation;
  }

  /**
   * Die Stripe-Seite: Gutschrift mit Erstattung, wenn der Checkout eine
   * Rechnung erzeugt hat (so steht die Stornorechnung mit eigener Nummer
   * und PDF neben der Rechnung), sonst eine schlichte Erstattung.
   *
   * Die Idempotenzschluessel haengen an der Checkout-Sitzung: dieselbe
   * Zahlung wird nie zweimal erstattet, eine spaetere neue Zahlung fuer
   * dieselbe Veranstaltung aber sehr wohl.
   */
  private async refundStripePayment(
    event: Event,
  ): Promise<StripeRefundOutcome> {
    const fail = (detail: string): never => {
      this.logger.error(
        `Erstattung für Event ${event.id} fehlgeschlagen: ${detail}`,
      );
      throw new BadGatewayException({
        code: ErrorCodes.STRIPE_API_ERROR,
        reason: ErrorReasons.REFUND_FAILED,
        message:
          'Die Erstattung über Stripe ist fehlgeschlagen. Es wurde nichts storniert — bitte versuche es später noch einmal.',
      });
    };

    if (!this.stripeService.isConfigured || !event.stripeCheckoutSessionId) {
      return fail('Stripe nicht konfiguriert oder keine Checkout-Sitzung');
    }

    const metadata = {
      eventId: event.id,
      organizationId: event.organizationId,
      reason: 'event_unlock_cancellation',
    };
    const keyBase = `event-unlock-cancel:${event.id}:${event.stripeCheckoutSessionId}`;

    try {
      const session = await this.stripeService.getCheckoutSessionForRefund(
        event.stripeCheckoutSessionId,
      );
      const paymentIntentId = idOf(session.payment_intent);
      const invoice =
        session.invoice && typeof session.invoice !== 'string'
          ? session.invoice
          : null;
      const invoiceId = idOf(session.invoice);

      if (invoice && invoiceId && invoice.status === 'paid') {
        const creditNote = await this.stripeService.createCreditNoteWithRefund({
          invoiceId,
          amountInCents: invoice.amount_paid,
          memo: `Stornierung der Freischaltung · ${event.name}`,
          metadata,
          idempotencyKey: `${keyBase}:credit-note`,
        });
        const refundId = this.stripeService.refundIdOfCreditNote(creditNote);
        const refund = refundId
          ? await this.stripeService.retrieveRefund(refundId)
          : null;
        return {
          stripePaymentIntentId: paymentIntentId,
          stripeInvoiceId: invoiceId,
          stripeCreditNoteId: creditNote.id,
          creditNoteNumber: creditNote.number ?? null,
          stripeRefundId: refundId,
          refundStatus: refund ? refundStatusOf(refund.status) : 'pending',
        };
      }

      if (!paymentIntentId) {
        return fail(`Sitzung ${session.id} ohne PaymentIntent`);
      }
      const refund = await this.stripeService.createRefund({
        paymentIntentId,
        metadata,
        idempotencyKey: `${keyBase}:refund`,
      });
      return {
        stripePaymentIntentId: paymentIntentId,
        stripeInvoiceId: invoiceId,
        stripeCreditNoteId: null,
        creditNoteNumber: null,
        stripeRefundId: refund.id,
        refundStatus: refundStatusOf(refund.status),
      };
    } catch (error) {
      if (error instanceof BadGatewayException) throw error;
      return fail((error as Error).message);
    }
  }

  /**
   * Stripe meldet einen neuen Stand einer Erstattung (refund.updated,
   * refund.failed). Erstattungen, die nicht aus einem Storno stammen,
   * werden uebergangen.
   */
  async handleRefundUpdate(refund: Stripe.Refund): Promise<void> {
    const record = await this.cancellationRepository.findOne({
      where: { stripeRefundId: refund.id },
    });
    if (!record) return;

    const next = refundStatusOf(refund.status);
    if (record.refundStatus === next) return;

    const before = record.refundStatus;
    record.refundStatus = next;
    await this.cancellationRepository.save(record);
    this.logger.log(
      `Erstattung ${refund.id} (Storno ${record.id}): ${before ?? '-'} -> ${next}`,
    );

    /* Gescheitert heisst: das Geld ist zurueck bei uns, nicht beim Kunden.
       Das muss jemand von Hand loesen — also Bescheid geben. */
    if (next === 'failed' || next === 'canceled') {
      try {
        const to =
          await this.platformSettingsService.resolveNotificationTarget(
            'eventOrdered',
          );
        if (to) {
          const event = await this.eventRepository.findOne({
            where: { id: record.eventId },
            withDeleted: true,
          });
          await this.emailService.sendAdminEventRefundFailedNotification({
            to,
            eventName: event?.name ?? record.eventId,
            organizationId: record.organizationId,
            amount: Number(record.amount),
            refundId: refund.id,
            failureReason: refund.failure_reason ?? null,
          });
        }
      } catch (error) {
        this.logger.warn(
          `Hinweis auf gescheiterte Erstattung nicht gesendet: ${(error as Error).message}`,
        );
      }
    }
  }

  /**
   * Bestaetigung an die Rechnungs-E-Mail (ersatzweise an den, der
   * storniert hat) und Hinweis an den Betreiber. Best effort: eine
   * gescheiterte Mail dreht keinen Storno zurueck.
   */
  private async notifyCancelled(
    event: Event,
    organization: Organization | null,
    cancellation: EventBillingCancellation,
    actor: User,
  ): Promise<void> {
    const via =
      cancellation.previousBillingStatus === 'paid' ? 'stripe' : 'invoice';
    const amount = Number(cancellation.amount);

    const customerEmail =
      organization?.billingEmail ||
      (cancellation.initiatedBy === 'organization' ? actor.email : null);
    if (customerEmail) {
      try {
        await this.emailService.sendEventUnlockCancelledEmail({
          to: customerEmail,
          organizationName: organization?.name ?? '',
          eventName: event.name,
          eventDate: event.startDate,
          timeZone: this.timezoneOf(organization),
          amount,
          currency: cancellation.currency,
          via,
          creditNoteNumber: cancellation.creditNoteNumber,
        });
      } catch (error) {
        this.logger.warn(
          `Storno-Bestätigung an ${customerEmail} nicht gesendet: ${(error as Error).message}`,
        );
      }
    }

    try {
      const to =
        await this.platformSettingsService.resolveNotificationTarget(
          'eventOrdered',
        );
      if (to) {
        await this.emailService.sendAdminEventUnlockCancelledNotification({
          to,
          organizationName: organization?.name ?? event.organizationId,
          eventName: event.name,
          eventDate: event.startDate,
          amount,
          via,
          initiatedBy: cancellation.initiatedBy,
          creditNoteNumber: cancellation.creditNoteNumber,
          manualCreditNoteRequired: cancellation.manualCreditNoteRequired,
          invoiceNote: cancellation.invoiceNote,
        });
      }
    } catch (error) {
      this.logger.warn(
        `Storno-Hinweis an den Betreiber nicht gesendet: ${(error as Error).message}`,
      );
    }
  }
}
