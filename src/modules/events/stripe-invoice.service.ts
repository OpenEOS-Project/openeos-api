import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import type Stripe from 'stripe';

import {
  Event,
  EventInvoiceStatus,
  EventStatus,
  isInvoiceOverdue,
} from '../../database/entities/event.entity';
import { Organization } from '../../database/entities/organization.entity';
import { Order } from '../../database/entities/order.entity';
import { EventBillingCancellation } from '../../database/entities/event-billing-cancellation.entity';
import {
  OrganizationRole,
  UserOrganization,
} from '../../database/entities/user-organization.entity';
import { AdminAction } from '../../database/entities/admin-audit-log.entity';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { shiftCalendarDaysInZone } from '../../common/utils/event-schedule.util';
import { StripeService } from '../stripe/stripe.service';
import { EmailService } from '../email/email.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { GatewayService } from '../gateway/gateway.service';
import { AuditActor, BillingAuditService } from './billing-audit.service';
import type { EventPrice } from './event-billing.service';

import { VAT_EXEMPT_NOTE } from '../../common/constants/billing-text';

export { VAT_EXEMPT_NOTE };

/** Zahlungsziel, wenn weder Organisation noch Umgebung eines nennen. */
export const DEFAULT_INVOICE_DAYS_UNTIL_DUE = 14;

/** Was von einer Stripe-Rechnung an der Veranstaltung gespiegelt wird. */
export interface InvoiceSnapshot {
  stripeInvoiceId: string;
  stripeInvoiceNumber: string | null;
  invoiceStatus: EventInvoiceStatus;
  invoiceDueAt: Date | null;
  invoicePaidAt: Date | null;
  invoiceHostedUrl: string | null;
  invoicePdfUrl: string | null;
}

/** Die Rechnung zur Freischaltung, wie Oberflaechen sie sehen. */
export interface EventInvoiceSummary {
  id: string;
  number: string | null;
  /** Stripes Status; zusaetzlich `overdue` fuer offene Rechnungen nach dem Faelligkeitsdatum. */
  status: EventInvoiceStatus | 'overdue';
  dueAt: string | null;
  paidAt: string | null;
  /** Stripes Rechnungsseite — dort laesst sich auch online bezahlen. */
  hostedUrl: string | null;
  /** Ob ein PDF abrufbar ist (ueber /billing/invoices/:id/pdf). */
  hasPdf: boolean;
}

export type InvoiceWebhookType =
  | 'invoice.finalized'
  | 'invoice.sent'
  | 'invoice.paid'
  | 'invoice.payment_failed'
  | 'invoice.voided'
  | 'invoice.marked_uncollectible';

export type CreditNoteWebhookType =
  | 'credit_note.created'
  | 'credit_note.voided';

const DEFAULT_TIMEZONE = 'Europe/Berlin';

function fromUnix(seconds: number | null | undefined): Date | null {
  return seconds ? new Date(seconds * 1000) : null;
}

function idOf(
  value: string | { id: string } | null | undefined,
): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

/** Die Felder einer Stripe-Rechnung, die an der Veranstaltung liegen. */
export function snapshotOf(invoice: Stripe.Invoice): InvoiceSnapshot {
  return {
    stripeInvoiceId: invoice.id ?? '',
    stripeInvoiceNumber: invoice.number ?? null,
    invoiceStatus: invoice.status ?? 'draft',
    invoiceDueAt: fromUnix(invoice.due_date),
    invoicePaidAt: fromUnix(invoice.status_transitions?.paid_at),
    invoiceHostedUrl: invoice.hosted_invoice_url ?? null,
    invoicePdfUrl: invoice.invoice_pdf ?? null,
  };
}

/** Die Rechnung einer Veranstaltung fuer Oberflaechen, null ohne Stripe-Rechnung. */
export function invoiceSummaryOf(
  event: Pick<
    Event,
    | 'stripeInvoiceId'
    | 'stripeInvoiceNumber'
    | 'invoiceStatus'
    | 'invoiceDueAt'
    | 'invoicePaidAt'
    | 'invoiceHostedUrl'
    | 'invoicePdfUrl'
  >,
  now: Date = new Date(),
): EventInvoiceSummary | null {
  if (!event.stripeInvoiceId) return null;
  return {
    id: event.stripeInvoiceId,
    number: event.stripeInvoiceNumber ?? null,
    status: isInvoiceOverdue(event, now)
      ? 'overdue'
      : (event.invoiceStatus ?? 'draft'),
    dueAt: event.invoiceDueAt
      ? new Date(event.invoiceDueAt).toISOString()
      : null,
    paidAt: event.invoicePaidAt
      ? new Date(event.invoicePaidAt).toISOString()
      : null,
    hostedUrl: event.invoiceHostedUrl ?? null,
    hasPdf: !!event.invoicePdfUrl,
  };
}

/**
 * Kauf auf Rechnung ueber Stripe Invoicing.
 *
 * Bisher hiess "auf Rechnung": die Veranstaltung ist frei, und der
 * Betreiber schreibt irgendwann von Hand eine Rechnung. Jetzt stellt Stripe
 * sie im Moment der Bestellung aus: Nummernkreis, PDF, Mail mit
 * Zahlungslink und Bankverbindung, Erinnerungen und die Zuordnung der
 * Ueberweisung — alles dort. Hier liegt der Spiegel (Status, Nummer,
 * Faelligkeit, Links) und die Reaktion auf Stripes Rueckmeldungen.
 *
 * Die Freischaltung haengt nicht am Zahlungseingang: `billing_status`
 * bleibt 'invoice', ob bezahlt ist, steht in `invoice_status`. Erst wenn
 * Stripe die Rechnung storniert oder abschreibt, faellt die Veranstaltung
 * zurueck — wie beim abgelaufenen Checkout, sofern niemand darin bestellt
 * hat.
 */
@Injectable()
export class StripeInvoiceService {
  private readonly logger = new Logger(StripeInvoiceService.name);

  constructor(
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(EventBillingCancellation)
    private readonly cancellationRepository: Repository<EventBillingCancellation>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    private readonly stripeService: StripeService,
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
    private readonly platformSettingsService: PlatformSettingsService,
    private readonly gatewayService: GatewayService,
    private readonly billingAudit: BillingAuditService,
  ) {}

  /** Ob Stripe die Rechnungen stellt — ohne Schluessel bleibt es beim alten Weg. */
  get isAvailable(): boolean {
    return this.stripeService.isConfigured;
  }

  /** Zahlungsziel in Tagen: Organisation vor Umgebung vor Standard. */
  daysUntilDue(
    organization: Pick<Organization, 'invoiceDaysUntilDue'>,
  ): number {
    const own = organization.invoiceDaysUntilDue;
    if (Number.isInteger(own) && (own as number) >= 1) return own as number;
    const configured = Number(
      this.configService.get<number>('billing.invoiceDaysUntilDue'),
    );
    return Number.isInteger(configured) && configured >= 1
      ? configured
      : DEFAULT_INVOICE_DAYS_UNTIL_DUE;
  }

  /**
   * Die Rechnung zur Freischaltung ausstellen und verschicken.
   *
   * Der Betrag kommt vom Aufrufer (EventBillingService rechnet ihn), die
   * Positionen entstehen hier: eine je Freischaltung mit Veranstaltung,
   * Zeitraum, Tagen und Tagespreis, dazu der Nachlass als eigene Zeile —
   * so steht auf der Rechnung, wofuer bezahlt wird, nicht nur eine Summe.
   *
   * Liefert den Spiegel fuer die Veranstaltung; gespeichert wird er vom
   * Aufrufer zusammen mit der Freischaltung.
   */
  async issue(params: {
    event: Event;
    organization: Organization;
    price: EventPrice;
    billingEmail: string;
  }): Promise<{ customerId: string; snapshot: InvoiceSnapshot }> {
    const { event, organization, price } = params;
    const currency = organization.settings?.currency || 'EUR';
    const timeZone = organization.settings?.timezone || DEFAULT_TIMEZONE;
    const address = organization.billingAddress;

    const customerId = await this.stripeService.ensureCustomer({
      existingCustomerId: organization.stripeCustomerId,
      organizationId: organization.id,
      // Rechnungsempfaenger, wie im Bestellformular eingetragen.
      organizationName: address?.name?.trim() || organization.name,
      email: params.billingEmail,
      address:
        address && address.street && address.zip && address.city
          ? {
              line1: address.street,
              postal_code: address.zip,
              city: address.city,
              country: address.country || 'DE',
            }
          : null,
    });

    const money = new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency,
    });
    const dayLabel =
      price.days === 1
        ? '1 Veranstaltungstag'
        : `${price.days} Veranstaltungstage`;
    const lines: { description: string; amountInCents: number }[] = [
      {
        description:
          `Freischaltung „${event.name}“ · ${this.periodOf(event, timeZone, price.businessDayStartHour)} · ` +
          `${dayLabel} × ${money.format(price.pricePerDay)}`,
        amountInCents: Math.round(price.price * 100),
      },
    ];
    const discountCents =
      Math.round(price.finalPrice * 100) - Math.round(price.price * 100);
    if (discountCents < 0) {
      lines.push({
        description:
          price.discountReason === 'first-event'
            ? `Nachlass für die erste Veranstaltung (−${price.discountPercent} %)`
            : `Nachlass für deine Organisation (−${price.discountPercent} %)`,
        amountInCents: discountCents,
      });
    }

    /* Der Schluessel enthaelt die Zahl der bisherigen Stornierungen: wer
       storniert und am selben Tag zum selben Preis neu bestellt, bekommt
       eine neue Rechnung — nicht die stornierte zurueck. */
    const cancellations = await this.cancellationRepository.count({
      where: { eventId: event.id },
    });
    const invoice = await this.stripeService.createAndSendInvoice({
      customerId,
      currency,
      description: `Freischaltung der Veranstaltung „${event.name}“ in OpenEOS`,
      footer: VAT_EXEMPT_NOTE,
      daysUntilDue: this.daysUntilDue(organization),
      lines,
      metadata: {
        eventId: event.id,
        organizationId: organization.id,
        days: String(price.days),
        kind: 'event_unlock',
      },
      idempotencyKey: `event-invoice:${event.id}:${cancellations}:${price.finalPrice}:${price.days}d`,
    });

    this.logger.log(
      `Stripe-Rechnung ${invoice.id} (${invoice.number ?? 'ohne Nummer'}) für Event ${event.id} ausgestellt: ${price.finalPrice} ${currency}`,
    );

    return { customerId, snapshot: snapshotOf(invoice) };
  }

  /**
   * Zeitraum der Veranstaltung fuer die Rechnungsposition.
   *
   * Ein Ende bis einschliesslich zum Tageswechsel (6:00) gehoert noch zum
   * Vortag — ein Fest "bis 2 Uhr" endet auf der Rechnung am selben Tag, an
   * dem es stattfand, nicht am Folgetag. Dieselbe Regel wie beim Zaehlen
   * der Veranstaltungstage.
   */
  private periodOf(
    event: Event,
    timeZone: string,
    businessDayStartHour: number,
  ): string {
    const format = new Intl.DateTimeFormat('de-DE', {
      dateStyle: 'medium',
      timeZone,
    });
    if (!event.startDate) return 'Termin offen';
    const start = format.format(new Date(event.startDate));
    if (!event.endDate) return start;
    let end = new Date(event.endDate);
    const parts = new Intl.DateTimeFormat('en-GB', {
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
      timeZone,
    }).formatToParts(end);
    const minutes =
      Number(parts.find((p) => p.type === 'hour')?.value ?? 0) * 60 +
      Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    if (
      minutes <= businessDayStartHour * 60 &&
      end > new Date(event.startDate)
    ) {
      end = shiftCalendarDaysInZone(end, -1, timeZone);
    }
    const endLabel = format.format(end);
    return start === endLabel ? start : `${start} – ${endLabel}`;
  }

  /**
   * Die Veranstaltung zu einer Stripe-Rechnung. Zuerst ueber die Metadaten
   * (unsere Rechnungen tragen die Event-Id), sonst ueber die gespiegelte
   * Rechnungs-Id. Rechnungen, die wir nicht kennen (im Dashboard von Hand
   * erstellt), gehoeren zu keiner Veranstaltung.
   */
  private async eventOfInvoice(invoice: Stripe.Invoice): Promise<Event | null> {
    const eventId = invoice.metadata?.eventId;
    if (eventId) {
      const byId = await this.eventRepository.findOne({
        where: { id: eventId },
        withDeleted: true,
      });
      if (byId) return byId;
    }
    if (!invoice.id) return null;
    return this.eventRepository.findOne({
      where: { stripeInvoiceId: invoice.id },
      withDeleted: true,
    });
  }

  /**
   * Stripes Stand der Rechnung an der Veranstaltung spiegeln — nur, wenn es
   * noch dieselbe Rechnung ist. Nach einem Storno mit Neubestellung haengt
   * eine neuere Rechnung an der Veranstaltung; die alte darf sie nicht
   * ueberschreiben.
   */
  private async mirror(
    event: Event,
    invoice: Stripe.Invoice,
  ): Promise<boolean> {
    if (!invoice.id || event.stripeInvoiceId !== invoice.id) return false;
    const snapshot = snapshotOf(invoice);
    const result = await this.eventRepository.update(
      { id: event.id, stripeInvoiceId: invoice.id },
      snapshot,
    );
    if (result.affected) Object.assign(event, snapshot);
    return !!result.affected;
  }

  /** Webhook `invoice.*` — siehe STRIPE_WEBHOOK_EVENTS. */
  async handleInvoiceEvent(
    type: InvoiceWebhookType,
    invoice: Stripe.Invoice,
    stripeEventId: string | null = null,
  ): Promise<void> {
    if (invoice.metadata?.kind && invoice.metadata.kind !== 'event_unlock') {
      return;
    }
    const event = await this.eventOfInvoice(invoice);
    if (!event) {
      this.logger.debug(
        `Stripe-Rechnung ${invoice.id ?? '-'} gehört zu keiner Veranstaltung (${type})`,
      );
      return;
    }
    const current = await this.mirror(event, invoice);

    switch (type) {
      case 'invoice.finalized':
      case 'invoice.sent':
        this.logger.log(
          `Stripe-Rechnung ${invoice.id} (${invoice.number ?? '-'}) für Event ${event.id}: ${type}`,
        );
        return;
      case 'invoice.paid':
        return this.onPaid(event, invoice, current, stripeEventId);
      case 'invoice.payment_failed':
        return this.onPaymentFailed(event, invoice, current, stripeEventId);
      case 'invoice.voided':
        return this.onClosed(event, invoice, current, 'void', stripeEventId);
      case 'invoice.marked_uncollectible':
        return this.onClosed(
          event,
          invoice,
          current,
          'uncollectible',
          stripeEventId,
        );
    }
  }

  /**
   * Bezahlt. Die Freischaltung gilt schon — hier bleibt nur, den Stand zu
   * merken, zu protokollieren und dem Betreiber Bescheid zu geben.
   *
   * Zahlung zu einer Rechnung, die nicht (mehr) an der Veranstaltung
   * haengt (nach Storno bezahlt, oder die Veranstaltung ist inzwischen
   * anders freigeschaltet): das Geld ist da und gehoert zurueck — das
   * entscheidet der Betreiber.
   */
  private async onPaid(
    event: Event,
    invoice: Stripe.Invoice,
    current: boolean,
    stripeEventId: string | null,
  ): Promise<void> {
    if (
      await this.billingAudit.hasEntryWithDetail(
        AdminAction.EVENT_INVOICE_PAID,
        'invoiceId',
        invoice.id ?? '',
      )
    ) {
      return;
    }
    const organization = await this.organizationRepository.findOne({
      where: { id: event.organizationId },
    });
    const amount = (invoice.amount_paid ?? 0) / 100;
    const currency = (invoice.currency ?? 'eur').toUpperCase();
    const orphaned = !current || event.billingStatus !== 'invoice';

    await this.billingAudit.record({
      action: AdminAction.EVENT_INVOICE_PAID,
      organizationId: event.organizationId,
      eventId: event.id,
      details: {
        stripeEventId,
        invoiceId: invoice.id,
        invoiceNumber: invoice.number ?? null,
        amount,
        currency,
        paidAt: fromUnix(invoice.status_transitions?.paid_at)?.toISOString(),
        billingStatus: event.billingStatus,
        orphaned,
      },
    });
    this.logger.log(
      `Stripe-Rechnung ${invoice.id} (${invoice.number ?? '-'}) für Event ${event.id} bezahlt: ${amount} ${currency}${orphaned ? ' — ohne Wirkung' : ''}`,
    );

    const money = new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency,
    }).format(amount);
    const rows: [string, string][] = [
      ['Organisation', organization?.name ?? event.organizationId],
      ['Veranstaltung', event.name],
      ['Rechnung', invoice.number ?? invoice.id ?? '-'],
      ['Betrag', money],
    ];
    try {
      if (orphaned) {
        const to =
          await this.platformSettingsService.resolvePlatformAdminEmail();
        if (!to) return;
        await this.emailService.sendAdminBillingAlert({
          to,
          subject: 'Zahlung zu einer aufgehobenen Rechnung',
          intro:
            'Eine Stripe-Rechnung wurde bezahlt, die zu keiner laufenden Freischaltung mehr gehört (storniert oder anders freigeschaltet). Die Zahlung schaltet nichts frei.',
          rows: [...rows, ['Status der Veranstaltung', event.billingStatus]],
          todo: {
            title: 'Bitte prüfen und erstatten',
            text: 'Im Stripe-Dashboard zur Rechnung eine Gutschrift mit Erstattung ausstellen und die Organisation informieren.',
          },
        });
        return;
      }
      const to =
        await this.platformSettingsService.resolveNotificationTarget(
          'eventOrdered',
        );
      if (!to) return;
      await this.emailService.sendAdminBillingAlert({
        to,
        subject: 'Rechnung bezahlt',
        intro: 'Eine Rechnung für eine Freischaltung auf Rechnung ist bezahlt.',
        rows,
        todo: null,
      });
    } catch (error) {
      this.logger.warn(
        `Hinweis "Rechnung bezahlt" nicht gesendet: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Eine Zahlung ueber die Rechnungsseite ist gescheitert (Karte abgelehnt,
   * Lastschrift geplatzt). Die Rechnung bleibt offen und bezahlbar, die
   * Freischaltung bleibt — die Organisation erfaehrt es, damit sie es
   * anders versucht, bevor die Rechnung ueberfaellig wird.
   */
  private async onPaymentFailed(
    event: Event,
    invoice: Stripe.Invoice,
    current: boolean,
    stripeEventId: string | null,
  ): Promise<void> {
    if (!current || !stripeEventId) return;
    if (
      await this.billingAudit.hasEntryWithDetail(
        AdminAction.EVENT_INVOICE_PAYMENT_FAILED,
        'stripeEventId',
        stripeEventId,
      )
    ) {
      return;
    }
    const failureReason = invoice.last_finalization_error?.message ?? null;
    await this.billingAudit.record({
      action: AdminAction.EVENT_INVOICE_PAYMENT_FAILED,
      organizationId: event.organizationId,
      eventId: event.id,
      details: {
        stripeEventId,
        invoiceId: invoice.id,
        invoiceNumber: invoice.number ?? null,
        attemptCount: invoice.attempt_count ?? null,
        failureReason,
      },
    });
    this.logger.warn(
      `Zahlung der Stripe-Rechnung ${invoice.id} (Event ${event.id}) fehlgeschlagen`,
    );
    if (event.deletedAt || invoice.status !== 'open') return;

    const organization = await this.organizationRepository.findOne({
      where: { id: event.organizationId },
    });
    for (const to of await this.recipientsOf(organization, event)) {
      try {
        await this.emailService.sendEventInvoicePaymentFailedEmail({
          to,
          organizationName: organization?.name ?? '',
          eventName: event.name,
          invoiceNumber: invoice.number ?? null,
          amount: (invoice.amount_remaining ?? invoice.amount_due ?? 0) / 100,
          currency: (invoice.currency ?? 'eur').toUpperCase(),
          dueAt: fromUnix(invoice.due_date),
          hostedUrl: invoice.hosted_invoice_url ?? null,
          failureReason,
        });
      } catch (error) {
        this.logger.warn(
          `Hinweis "Zahlung fehlgeschlagen" an ${to} nicht gesendet: ${(error as Error).message}`,
        );
      }
    }
  }

  /**
   * Stripe hat die Rechnung storniert (void) oder abgeschrieben
   * (uncollectible). Kam das von unserem eigenen Storno, ist alles schon
   * erledigt. Sonst — etwa aus dem Stripe-Dashboard — faellt die
   * Freischaltung wie beim abgelaufenen Checkout zurueck: nicht
   * freigeschaltet, eine aktive Veranstaltung in den Testmodus, Mail an die
   * Organisation.
   *
   * Ausnahme: echte Bestellungen. Eine genutzte Veranstaltung in den
   * Testmodus zu zwingen hiesse, die Kasse mitten im Betrieb zu begrenzen.
   * Dann bleibt die Freischaltung, und der Betreiber bekommt den Fall zum
   * Entscheiden (erlassen oder neu abrechnen).
   */
  private async onClosed(
    event: Event,
    invoice: Stripe.Invoice,
    current: boolean,
    reason: 'void' | 'uncollectible',
    stripeEventId: string | null,
  ): Promise<void> {
    const invoiceId = invoice.id ?? '';
    const action =
      reason === 'void'
        ? AdminAction.EVENT_INVOICE_VOIDED
        : AdminAction.EVENT_INVOICE_UNCOLLECTIBLE;
    if (!current || event.billingStatus !== 'invoice') return;
    if (
      await this.cancellationRepository.count({
        where: { stripeInvoiceId: invoiceId, kind: 'cancellation' },
      })
    ) {
      // Unser eigener Storno hat die Rechnung storniert — schon verbucht.
      return;
    }
    if (
      await this.billingAudit.hasEntryWithDetail(action, 'invoiceId', invoiceId)
    ) {
      return;
    }

    const outcome = await this.eventRepository.manager.transaction(
      async (manager: EntityManager) => {
        await manager.query(`SELECT id FROM events WHERE id = $1 FOR UPDATE`, [
          event.id,
        ]);
        const events = manager.getRepository(Event);
        const fresh = await events.findOne({ where: { id: event.id } });
        if (
          !fresh ||
          fresh.billingStatus !== 'invoice' ||
          fresh.stripeInvoiceId !== invoiceId
        ) {
          return null;
        }
        const realOrders = await manager.getRepository(Order).count({
          where: { eventId: fresh.id, isTest: false },
        });
        if (realOrders > 0) {
          return { event: fresh, released: false, realOrders };
        }
        const record = manager.getRepository(EventBillingCancellation).create({
          eventId: fresh.id,
          organizationId: fresh.organizationId,
          cancelledBy: null,
          initiatedBy: 'platform',
          kind: 'cancellation',
          reason:
            reason === 'void'
              ? 'Stripe-Rechnung storniert (void)'
              : 'Stripe-Rechnung uneinbringlich (uncollectible)',
          previousBillingStatus: 'invoice',
          amount: Number(fresh.priceCharged ?? 0),
          currency: (invoice.currency ?? 'eur').toUpperCase(),
          paidAt: fresh.paidAt,
          billedDays: fresh.billedDays ?? null,
          deadline: null,
          stripeCheckoutSessionId: null,
          stripeInvoiceId: invoiceId,
          invoiceVoided: reason === 'void',
          refundVia: reason === 'void' ? 'void' : null,
          invoicedAt: fresh.invoicedAt,
          invoiceNote: fresh.invoiceNote,
          manualCreditNoteRequired: false,
        });
        await manager.getRepository(EventBillingCancellation).save(record);

        const statusBefore = fresh.status;
        this.clearUnlock(fresh);
        await events.save(fresh);
        return {
          event: fresh,
          released: true,
          realOrders,
          statusChanged: statusBefore !== fresh.status,
        };
      },
    );
    if (!outcome) return;

    await this.billingAudit.record({
      action,
      organizationId: event.organizationId,
      eventId: event.id,
      details: {
        stripeEventId,
        invoiceId,
        invoiceNumber: invoice.number ?? null,
        amount: Number(event.priceCharged ?? 0),
        released: outcome.released,
        realOrders: outcome.realOrders,
      },
    });
    this.logger.log(
      `Stripe-Rechnung ${invoiceId} für Event ${event.id} ${reason}: Freischaltung ${outcome.released ? 'aufgehoben' : 'bleibt (Bestellungen vorhanden)'}`,
    );
    if (outcome.released && outcome.statusChanged) {
      this.gatewayService.notifyEventStatusChanged(event.organizationId, {
        eventId: event.id,
        organizationId: event.organizationId,
        status: outcome.event.status,
        name: event.name,
      });
    }

    const organization = await this.organizationRepository.findOne({
      where: { id: event.organizationId },
    });
    if (!event.deletedAt) {
      for (const to of await this.recipientsOf(organization, event)) {
        try {
          await this.emailService.sendEventInvoiceClosedEmail({
            to,
            organizationName: organization?.name ?? '',
            eventName: event.name,
            eventDate: event.startDate,
            timeZone: organization?.settings?.timezone || DEFAULT_TIMEZONE,
            invoiceNumber: invoice.number ?? null,
            reason,
            activationReleased: outcome.released,
          });
        } catch (error) {
          this.logger.warn(
            `Hinweis "Rechnung ${reason}" an ${to} nicht gesendet: ${(error as Error).message}`,
          );
        }
      }
    }
    if (!outcome.released) {
      try {
        const to =
          await this.platformSettingsService.resolvePlatformAdminEmail();
        if (to) {
          await this.emailService.sendAdminBillingAlert({
            to,
            subject:
              reason === 'void'
                ? 'Rechnung storniert, Veranstaltung mit Bestellungen'
                : 'Rechnung uneinbringlich, Veranstaltung mit Bestellungen',
            intro:
              'Die Stripe-Rechnung zu einer Freischaltung auf Rechnung wurde geschlossen, aber in der Veranstaltung gibt es echte Bestellungen. Die Freischaltung bleibt deshalb bestehen.',
            rows: [
              ['Organisation', organization?.name ?? event.organizationId],
              ['Veranstaltung', event.name],
              ['Rechnung', invoice.number ?? invoiceId],
              ['Echte Bestellungen', String(outcome.realOrders)],
            ],
            todo: {
              title: 'Bitte entscheiden',
              text: 'Die Veranstaltung im Adminbereich erlassen oder eine neue Rechnung stellen.',
            },
          });
        }
      } catch (error) {
        this.logger.warn(
          `Hinweis an den Betreiber nicht gesendet: ${(error as Error).message}`,
        );
      }
    }
  }

  /** Die Freischaltung samt Rechnungsspiegel von der Veranstaltung nehmen. */
  private clearUnlock(event: Event): void {
    event.billingStatus = 'none';
    event.paidAt = null;
    event.priceCharged = null;
    event.billedDays = null;
    event.stripeCheckoutSessionId = null;
    event.unlockedStartDate = null;
    event.invoicedAt = null;
    event.invoicedBy = null;
    event.invoiceNote = null;
    event.stripeInvoiceId = null;
    event.stripeInvoiceNumber = null;
    event.invoiceStatus = null;
    event.invoiceDueAt = null;
    event.invoicePaidAt = null;
    event.invoiceHostedUrl = null;
    event.invoicePdfUrl = null;
    if (event.status === EventStatus.ACTIVE) {
      event.status = EventStatus.TEST;
    }
  }

  /**
   * Webhook `credit_note.*`: Gutschriften ins Protokoll. Unsere eigenen
   * (aus Storno/Kulanz) sind schon mit Nummer in der Stornierung — hier
   * wird nur nachgetragen, was beim Anlegen noch fehlte. Fremde
   * (Dashboard) landen ebenfalls im Protokoll, damit der Betreiber sie
   * neben der Freischaltung sieht.
   */
  async handleCreditNoteEvent(
    type: CreditNoteWebhookType,
    note: Stripe.CreditNote,
    stripeEventId: string | null = null,
  ): Promise<void> {
    const invoiceId = idOf(note.invoice);
    const record = await this.cancellationRepository.findOne({
      where: { stripeCreditNoteId: note.id },
    });
    const event = record
      ? await this.eventRepository.findOne({
          where: { id: record.eventId },
          withDeleted: true,
        })
      : invoiceId
        ? ((await this.eventRepository.findOne({
            where: { stripeInvoiceId: invoiceId },
            withDeleted: true,
          })) ??
          (await this.cancellationRepository
            .findOne({
              where: { stripeInvoiceId: invoiceId },
              order: { createdAt: 'DESC' },
            })
            .then((row) =>
              row
                ? this.eventRepository.findOne({
                    where: { id: row.eventId },
                    withDeleted: true,
                  })
                : null,
            )))
        : null;

    if (record && note.number && record.creditNoteNumber !== note.number) {
      record.creditNoteNumber = note.number;
      await this.cancellationRepository.save(record);
    }

    const action = AdminAction.EVENT_INVOICE_CREDIT_NOTE;
    const key = `${note.id}:${type}`;
    if (
      await this.billingAudit.hasEntryWithDetail(action, 'creditNoteId', key)
    ) {
      return;
    }
    await this.billingAudit.record({
      action,
      organizationId: event?.organizationId ?? record?.organizationId ?? null,
      eventId: event?.id ?? record?.eventId ?? null,
      details: {
        stripeEventId,
        creditNoteId: key,
        creditNote: note.id,
        number: note.number ?? null,
        invoiceId,
        amount: (note.total ?? 0) / 100,
        currency: (note.currency ?? 'eur').toUpperCase(),
        status:
          type === 'credit_note.voided' ? 'void' : (note.status ?? 'issued'),
        reason: note.reason ?? null,
        memo: note.memo ?? null,
        cancellationId: record?.id ?? null,
        origin: record ? 'openeos' : 'stripe',
      },
    });
    this.logger.log(
      `Gutschrift ${note.id} (${note.number ?? '-'}) ${type === 'credit_note.voided' ? 'aufgehoben' : 'ausgestellt'} für Rechnung ${invoiceId ?? '-'}${event ? `, Event ${event.id}` : ''}`,
    );
  }

  /** Die Veranstaltung mit Stripe-Rechnung fuer Admin-Aktionen. */
  private async eventWithInvoice(eventId: string): Promise<Event> {
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
    if (!event.stripeInvoiceId) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.EVENT_NO_STRIPE_INVOICE,
        message: 'Zu dieser Veranstaltung gibt es keine Stripe-Rechnung',
      });
    }
    return event;
  }

  /** Super-Admin: Stripes Rechnungsmail erneut verschicken. */
  async resend(eventId: string, actor: AuditActor): Promise<Event> {
    const event = await this.eventWithInvoice(eventId);
    if (event.invoiceStatus !== 'open') {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.EVENT_INVOICE_NOT_OPEN,
        message: 'Nur offene Rechnungen lassen sich erneut senden',
      });
    }
    const invoice = await this.stripeService.sendInvoice(
      event.stripeInvoiceId as string,
    );
    await this.mirror(event, invoice);
    await this.billingAudit.record({
      action: AdminAction.EVENT_INVOICE_RESENT,
      organizationId: event.organizationId,
      eventId: event.id,
      actor,
      details: { invoiceId: invoice.id, invoiceNumber: invoice.number ?? null },
    });
    this.logger.log(
      `Stripe-Rechnung ${invoice.id} für Event ${event.id} erneut gesendet`,
    );
    return event;
  }

  /**
   * Super-Admin: Rechnung als ausserhalb von Stripe bezahlt verbuchen
   * (Ueberweisung auf das eigene Konto). Stripe setzt sie auf bezahlt und
   * meldet `invoice.paid`; der Spiegel wird hier schon gesetzt, damit die
   * Oberflaeche nicht auf den Webhook wartet.
   */
  async markPaid(eventId: string, actor: AuditActor): Promise<Event> {
    const event = await this.eventWithInvoice(eventId);
    if (event.invoiceStatus !== 'open') {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.EVENT_INVOICE_NOT_OPEN,
        message: 'Nur offene Rechnungen lassen sich als bezahlt markieren',
      });
    }
    const invoice = await this.stripeService.markInvoicePaidOutOfBand(
      event.stripeInvoiceId as string,
    );
    await this.mirror(event, invoice);
    await this.billingAudit.record({
      action: AdminAction.EVENT_INVOICE_MARKED_PAID,
      organizationId: event.organizationId,
      eventId: event.id,
      actor,
      details: {
        invoiceId: invoice.id,
        invoiceNumber: invoice.number ?? null,
        amount: (invoice.amount_paid ?? 0) / 100,
      },
    });
    this.logger.log(
      `Stripe-Rechnung ${invoice.id} für Event ${event.id} als bezahlt markiert`,
    );
    return event;
  }

  /** Das PDF der Rechnung einer Veranstaltung, fuer den Super-Admin. */
  async invoicePdf(
    eventId: string,
  ): Promise<{ filename: string; content: Buffer }> {
    const event = await this.eventWithInvoice(eventId);
    if (!event.invoicePdfUrl) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.INVOICE_PDF_NOT_AVAILABLE,
        message: 'Für diese Rechnung liegt noch kein PDF vor',
      });
    }
    const content = await this.stripeService.fetchInvoicePdf(
      event.invoicePdfUrl,
    );
    return {
      filename: `${event.stripeInvoiceNumber ?? event.stripeInvoiceId}.pdf`,
      content,
    };
  }

  /**
   * An die Rechnungs-E-Mail, ersatzweise an alle Administratoren der
   * Organisation.
   */
  private async recipientsOf(
    organization: Organization | null,
    event: Event,
  ): Promise<string[]> {
    if (organization?.billingEmail) return [organization.billingEmail];
    const memberships = await this.userOrganizationRepository.find({
      where: {
        organizationId: event.organizationId,
        role: OrganizationRole.ADMIN,
      },
      relations: ['user'],
    });
    return [
      ...new Set(
        memberships
          .map((m) => m.user?.email)
          .filter((email): email is string => !!email),
      ),
    ];
  }
}
