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
  EventBillingCancellationKind,
  EventRefundStatus,
} from '../../database/entities/event-billing-cancellation.entity';
import { AdminAction } from '../../database/entities/admin-audit-log.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { User } from '../../database/entities';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { shiftCalendarDaysInZone } from '../../common/utils/event-schedule.util';
import { OrganizationsService } from '../organizations/organizations.service';
import { StripeService } from '../stripe/stripe.service';
import { EmailService } from '../email/email.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { GatewayService } from '../gateway/gateway.service';
import { AuditActor, BillingAuditService } from './billing-audit.service';

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
  /** Storno (Freischaltung aufgehoben) oder Kulanz (Freischaltung bleibt). */
  kind: EventBillingCancellationKind;
  reason: string | null;
}

/**
 * Was der Super-Admin vor einem Storno bzw. einer Kulanzerstattung sieht.
 * Betraege in der Waehrung der Organisation.
 */
export interface PlatformCancellationPreview {
  eventId: string;
  billingStatus: string;
  via: 'stripe' | 'invoice' | null;
  currency: string;
  amountCharged: number;
  /** Schon per Kulanz erstattet (seit dieser Freischaltung). */
  refundedSoFar: number;
  /** Hoechstens noch erstattbar. */
  refundable: number;
  /** Echte Bestellungen (ohne Testbestellungen). */
  realOrders: number;
  deadline: string | null;
  /** Zeitzone der Organisation — die Oberflaeche zeigt die Frist darin. */
  timezone: string;
  deadlinePassed: boolean;
  /** Ob die Rechnung (Kauf auf Rechnung) schon gestellt ist. */
  invoiced: boolean;
  onlineRefundAvailable: boolean;
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
    kind: record.kind ?? 'cancellation',
    reason: record.reason ?? null,
  };
}

/** Euro-Betrag in Cent, ohne Gleitkomma-Rest. */
function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/**
 * Was seit der letzten Freischaltung schon per Kulanz erstattet wurde: die
 * Kulanzzeilen nach dem letzten Storno (ein Storno beendet eine
 * Freischaltung, alles danach gehoert zur naechsten).
 */
function refundedSinceUnlock(rowsNewestFirst: EventBillingCancellation[]): {
  amount: number;
  count: number;
} {
  let cents = 0;
  let count = 0;
  for (const row of rowsNewestFirst) {
    if ((row.kind ?? 'cancellation') === 'cancellation') break;
    cents += toCents(Number(row.amount));
    count += 1;
  }
  return { amount: cents / 100, count };
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
 * - nur bis 7 Kalendertage vor Beginn (siehe cancellationDeadline),
 * - nur ohne echte Bestellungen; Testbestellungen zaehlen nicht,
 * - die Plattform darf beides uebergehen und auch teilweise erstatten
 *   (siehe cancelForPlatform),
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
    private readonly billingAudit: BillingAuditService,
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
    // Kulanzerstattungen heben die Freischaltung nicht auf — kein Storno.
    const record = await this.cancellationRepository.findOne({
      where: { eventId, kind: 'cancellation' },
      order: { createdAt: 'DESC' },
    });
    return record ? toCancellationSummary(record) : null;
  }

  /** Wurde die Freischaltung aus dieser Checkout-Sitzung schon storniert? */
  async wasCheckoutCancelled(sessionId: string): Promise<boolean> {
    const count = await this.cancellationRepository.count({
      where: { stripeCheckoutSessionId: sessionId, kind: 'cancellation' },
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
   * Storno bzw. Kulanzerstattung durch die Plattform (Super-Admin).
   *
   * Anders als die Organisation darf die Plattform alles: ohne Frist, auch
   * bei echten Bestellungen, ganz oder teilweise — mit Pflicht-Begruendung.
   *
   * - Keine echten Bestellungen und der volle (Rest-)Betrag: ein Storno wie
   *   bei der Organisation — die Freischaltung ist aufgehoben, eine aktive
   *   Veranstaltung faellt in den Testmodus.
   * - Echte Bestellungen oder nur ein Teilbetrag: Kulanz. Die Freischaltung
   *   und der Veranstaltungsstatus bleiben, Bestellungen bleiben
   *   unveraendert. Eine genutzte Veranstaltung in den Testmodus zu
   *   zwingen, hiesse: die Kasse mitten im Betrieb auf 25 Testbestellungen
   *   begrenzen, und beim naechsten Aktivieren wuerden die seither
   *   gebuchten (Test-)Bestellungen geloescht. Wer erstattet bekommt, soll
   *   seine Veranstaltung trotzdem ordentlich zu Ende fuehren koennen.
   *
   * Stripe: Gutschrift (Credit Note) ueber den Betrag mit Erstattung, ohne
   * Rechnung aus dem Checkout eine (Teil-)Erstattung der Zahlung.
   */
  async cancelForPlatform(
    eventId: string,
    admin: User,
    options: {
      reason: string;
      amount?: number | null;
      audit?: AuditActor | null;
    },
    now: Date = new Date(),
  ): Promise<EventBillingCancellation> {
    const reason = options.reason?.trim();
    if (!reason) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.REFUND_REASON_REQUIRED,
        message: 'Bitte gib einen Grund an',
      });
    }
    return this.cancel({
      eventId,
      organizationId: null,
      actor: admin,
      initiatedBy: 'platform',
      enforceDeadline: false,
      now,
      platform: {
        reason,
        amount: options.amount ?? null,
        audit: options.audit ?? null,
      },
    });
  }

  /** Was ein Storno/eine Kulanz durch die Plattform gerade bewirken wuerde. */
  async platformPreview(
    eventId: string,
    now: Date = new Date(),
  ): Promise<PlatformCancellationPreview> {
    const event = await this.eventRepository.findOne({
      where: { id: eventId },
    });
    if (!event) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.EVENT_NOT_FOUND,
        message: 'Event nicht gefunden',
      });
    }
    const organization = await this.eventRepository.manager
      .getRepository(Organization)
      .findOne({ where: { id: event.organizationId } });
    const timezone = this.timezoneOf(organization);
    const deadline = cancellationDeadline(event, timezone);
    const realOrders = await this.orderRepository.count({
      where: { eventId: event.id, isTest: false },
    });
    const paid = EVENT_PAID_BILLING_STATUSES.includes(event.billingStatus);
    const rows = paid
      ? await this.cancellationRepository.find({
          where: { eventId: event.id },
          order: { createdAt: 'DESC' },
        })
      : [];
    const refunded = refundedSinceUnlock(rows);
    const amountCharged = paid ? Number(event.priceCharged ?? 0) : 0;
    const refundable = Math.max(
      0,
      (toCents(amountCharged) - toCents(refunded.amount)) / 100,
    );
    return {
      eventId: event.id,
      billingStatus: event.billingStatus,
      via: paid
        ? event.billingStatus === 'paid'
          ? 'stripe'
          : 'invoice'
        : null,
      currency: organization?.settings?.currency || 'EUR',
      amountCharged,
      refundedSoFar: refunded.amount,
      refundable,
      realOrders,
      deadline: deadline ? deadline.toISOString() : null,
      timezone,
      deadlinePassed: !!deadline && now.getTime() >= deadline.getTime(),
      invoiced: !!event.invoicedAt,
      onlineRefundAvailable:
        event.billingStatus !== 'paid' ||
        (this.stripeService.isConfigured && !!event.stripeCheckoutSessionId),
    };
  }

  private async cancel(options: {
    eventId: string;
    organizationId: string | null;
    actor: User;
    initiatedBy: EventBillingCancellationInitiator;
    enforceDeadline: boolean;
    now: Date;
    /** Nur Plattform: Begruendung, Betrag (null = alles), Protokoll. */
    platform?: {
      reason: string;
      amount: number | null;
      audit: AuditActor | null;
    };
  }): Promise<EventBillingCancellation> {
    const {
      eventId,
      organizationId,
      actor,
      initiatedBy,
      enforceDeadline,
      now,
      platform,
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
        // Die Plattform darf auch bei echten Bestellungen (Kulanz).
        if (orders > 0 && !platform) {
          throw new BadRequestException({
            code: ErrorCodes.VALIDATION_ERROR,
            reason: ErrorReasons.EVENT_HAS_ORDERS,
            message:
              'In der Veranstaltung gibt es schon Bestellungen — eine kostenlose Stornierung ist nicht mehr möglich',
            params: { orders },
          });
        }

        /* Betrag: was von dieser Freischaltung noch nicht (per Kulanz)
           erstattet ist; die Plattform kann weniger waehlen. */
        const charged = Number(event.priceCharged ?? 0);
        const history = await cancellations.find({
          where: { eventId: event.id },
          order: { createdAt: 'DESC' },
        });
        const earlier = refundedSinceUnlock(history);
        const remainingCents = toCents(charged) - toCents(earlier.amount);
        const requestedCents =
          platform?.amount !== null && platform?.amount !== undefined
            ? toCents(platform.amount)
            : remainingCents;
        /* Doppelklick bzw. wiederholte Anfrage: dieselbe Kulanz desselben
           Admins von eben noch einmal zurueckgeben statt ein zweites Mal
           zu erstatten. Bewusst gewollte zweite Teilerstattungen liegen
           nicht innerhalb von zwei Minuten mit gleichem Betrag. */
        const latest = history[0];
        if (
          platform &&
          latest &&
          latest.kind === 'goodwill' &&
          latest.cancelledBy === actor.id &&
          toCents(Number(latest.amount)) === requestedCents &&
          now.getTime() - new Date(latest.createdAt).getTime() < 2 * 60 * 1000
        ) {
          return {
            event,
            organization,
            cancellation: latest,
            replayed: true,
            statusChanged: false,
          };
        }
        if (platform) {
          if (remainingCents <= 0) {
            throw new BadRequestException({
              code: ErrorCodes.VALIDATION_ERROR,
              reason: ErrorReasons.REFUND_NOTHING_TO_REFUND,
              message: 'Für diese Freischaltung ist nichts mehr zu erstatten',
            });
          }
          if (!(requestedCents > 0)) {
            throw new BadRequestException({
              code: ErrorCodes.VALIDATION_ERROR,
              reason: ErrorReasons.REFUND_AMOUNT_INVALID,
              message: 'Der Betrag muss größer als 0 sein',
            });
          }
          if (requestedCents > remainingCents) {
            throw new BadRequestException({
              code: ErrorCodes.VALIDATION_ERROR,
              reason: ErrorReasons.REFUND_EXCEEDS_REFUNDABLE,
              message: `Erstattbar sind höchstens ${(remainingCents / 100).toFixed(2)}`,
              params: { max: (remainingCents / 100).toFixed(2) },
            });
          }
        }
        const fullRemaining = requestedCents === remainingCents;
        /* Kulanz statt Storno: mit echten Bestellungen oder bei einem
           Teilbetrag bleibt die Freischaltung (siehe cancelForPlatform). */
        const kind: EventBillingCancellationKind =
          platform && (orders > 0 || !fullRemaining)
            ? 'goodwill'
            : 'cancellation';

        const previousBillingStatus = event.billingStatus as 'paid' | 'invoice';
        const record = cancellations.create({
          eventId: event.id,
          organizationId: event.organizationId,
          cancelledBy: actor.id,
          initiatedBy,
          kind,
          reason: platform?.reason ?? null,
          previousBillingStatus,
          amount: requestedCents / 100,
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
          Object.assign(
            record,
            await this.refundStripePayment(event, {
              /* Ganzer, unberuehrter Betrag: Stripe bestimmt ihn selbst
                 (Rechnungsbetrag bzw. die ganze Zahlung) — das bleibt
                 exakt, auch wenn priceCharged gerundet ist. */
              amountInCents:
                fullRemaining && earlier.count === 0 ? null : requestedCents,
              keySuffix:
                kind === 'goodwill'
                  ? `:goodwill:${earlier.count + 1}:${requestedCents}`
                  : earlier.count > 0
                    ? `:rest:${requestedCents}`
                    : '',
              memo:
                kind === 'goodwill'
                  ? `Kulanzerstattung · ${event.name}`
                  : `Stornierung der Freischaltung · ${event.name}`,
            }),
          );
        }

        const statusBefore = event.status;
        if (kind === 'cancellation') {
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
        }
        const saved = await cancellations.save(record);

        return {
          event,
          organization,
          cancellation: saved,
          replayed: false,
          statusChanged: statusBefore !== event.status,
          realOrders: orders,
        };
      },
    );

    if (outcome.replayed) return outcome.cancellation;

    const { event, organization, cancellation, statusChanged } = outcome;
    this.logger.log(
      `Freischaltung ${cancellation.kind === 'goodwill' ? 'per Kulanz erstattet' : 'storniert'}: ` +
        `event=${event.id} org=${event.organizationId} ` +
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

    if (platform) {
      await this.billingAudit.record({
        action:
          cancellation.kind === 'goodwill'
            ? AdminAction.EVENT_BILLING_GOODWILL_REFUND
            : AdminAction.EVENT_BILLING_CANCELLED,
        organizationId: event.organizationId,
        eventId: event.id,
        reason: platform.reason,
        actor: platform.audit ?? {
          userId: actor.id,
          ipAddress: '0.0.0.0',
        },
        details: {
          cancellationId: cancellation.id,
          kind: cancellation.kind,
          amount: Number(cancellation.amount),
          currency: cancellation.currency,
          via: cancellation.previousBillingStatus,
          realOrders: outcome.realOrders ?? 0,
          stripeRefundId: cancellation.stripeRefundId,
          creditNoteNumber: cancellation.creditNoteNumber,
          keepsUnlock: cancellation.kind === 'goodwill',
        },
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
    options: {
      /** null: alles, was Stripe noch erstatten kann. */
      amountInCents: number | null;
      /** Unterscheidet Kulanz-/Resterstattungen vom einfachen Storno. */
      keySuffix: string;
      memo: string;
    },
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
      reason: options.keySuffix.startsWith(':goodwill')
        ? 'event_unlock_goodwill'
        : 'event_unlock_cancellation',
    };
    const keyBase = `event-unlock-cancel:${event.id}:${event.stripeCheckoutSessionId}${options.keySuffix}`;

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
        // Was von der Rechnung noch nicht gutgeschrieben ist.
        const creditable =
          invoice.amount_paid - (invoice.post_payment_credit_notes_amount ?? 0);
        const amount = options.amountInCents ?? creditable;
        if (amount > creditable) {
          throw new BadRequestException({
            code: ErrorCodes.VALIDATION_ERROR,
            reason: ErrorReasons.REFUND_EXCEEDS_REFUNDABLE,
            message: `Erstattbar sind höchstens ${(creditable / 100).toFixed(2)}`,
            params: { max: (creditable / 100).toFixed(2) },
          });
        }
        const creditNote = await this.stripeService.createCreditNoteWithRefund({
          invoiceId,
          amountInCents: amount,
          memo: options.memo,
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
        amountInCents: options.amountInCents ?? undefined,
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
      if (
        error instanceof BadGatewayException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
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
    const goodwill = cancellation.kind === 'goodwill';
    if (customerEmail && goodwill) {
      try {
        await this.emailService.sendEventGoodwillRefundEmail({
          to: customerEmail,
          organizationName: organization?.name ?? '',
          eventName: event.name,
          amount,
          currency: cancellation.currency,
          via,
          creditNoteNumber: cancellation.creditNoteNumber,
        });
      } catch (error) {
        this.logger.warn(
          `Kulanz-Bestätigung an ${customerEmail} nicht gesendet: ${(error as Error).message}`,
        );
      }
    } else if (customerEmail) {
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
          kind: cancellation.kind,
          reason: cancellation.reason,
        });
      }
    } catch (error) {
      this.logger.warn(
        `Storno-Hinweis an den Betreiber nicht gesendet: ${(error as Error).message}`,
      );
    }
  }
}
