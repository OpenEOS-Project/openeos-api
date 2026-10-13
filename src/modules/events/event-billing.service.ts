import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import {
  Event,
  EVENT_PAID_BILLING_STATUSES,
  EVENT_UNLOCKED_BILLING_STATUSES,
  isEventBillingUnlocked,
} from '../../database/entities/event.entity';
import {
  Organization,
  BillingAddress,
} from '../../database/entities/organization.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { User } from '../../database/entities';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { OrganizationsService } from '../organizations/organizations.service';
import {
  countBillableDays,
  countCalendarDays,
  normalizeBusinessDayStartHour,
  parseEventDateInput,
} from '../../common/utils/event-schedule.util';
import { StripeService } from '../stripe/stripe.service';
import { EmailService } from '../email/email.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { OrderInvoiceDto } from './dto/event-billing.dto';
import { BillingAuditService } from './billing-audit.service';
import { AdminAction } from '../../database/entities/admin-audit-log.entity';
import {
  CancellationInfo,
  CancellationSummary,
  EventUnlockCancellationService,
} from './event-unlock-cancellation.service';

/* hasBilledEventBefore schliesst die laufende Veranstaltung aus. Bei einer
   Vorschau gibt es keine; diese Id trifft auf keine Zeile zu. */
const NICHTS_AUSSCHLIESSEN = '00000000-0000-0000-0000-000000000000';

/** Woher der gewaehrte Nachlass stammt — die Oberflaeche beschriftet ihn danach. */
export type DiscountReason = 'first-event' | 'organization' | null;

export interface EventPrice {
  /** Preis je Veranstaltungstag, vor Nachlass. */
  pricePerDay: number;
  /** Abgerechnete Veranstaltungstage (Geschaeftstage, siehe countBillableDays). */
  days: number;
  /**
   * Stunde, zu der ein Veranstaltungstag wechselt (Ortszeit der
   * Organisation). Mitgeliefert, damit der Hinweis "von 6 bis 6 Uhr" in der
   * Oberflaeche nicht eine zweite, irgendwann abweichende 6 kennt.
   */
  businessDayStartHour: number;
  /** pricePerDay * days, vor Nachlass. */
  price: number;
  discountPercent: number;
  discountReason: DiscountReason;
  finalPrice: number;
}

/** Preisvorschau samt der Grenze, bis zu der sich kostenlos testen laesst. */
export interface EventPricePreview extends EventPrice {
  testEventMaxOrders: number;
}

export interface EventBillingInfo extends EventPrice {
  /** Ob die Online-Zahlung ueberhaupt zur Verfuegung steht. */
  onlinePaymentAvailable: boolean;
  billingMode: string;
  billingStatus: string;
  organizationName: string;
  billingEmail: string | null;
  billingAddress: BillingAddress | null;
  /** Wann bezahlt bzw. auf Rechnung bestellt wurde (ISO). */
  paidAt: string | null;
  /** Der tatsaechlich berechnete Betrag. */
  priceCharged: number | null;
  /** Ob und bis wann sich die Freischaltung kostenlos stornieren laesst. */
  cancellation: CancellationInfo;
  /** Die letzte Stornierung, falls es eine gab. */
  lastCancellation: CancellationSummary | null;
}

/**
 * Eine von Stripe ausgestellte Rechnung oder Gutschrift (Stornorechnung),
 * auf das reduziert, was die Liste zeigt.
 */
export interface OrganizationInvoice {
  id: string;
  /** Rechnung oder Stornorechnung. */
  kind: 'invoice' | 'credit_note';
  /** Bei einer Stornorechnung: die Nummer der aufgehobenen Rechnung. */
  relatedInvoiceNumber: string | null;
  /** Fortlaufende Rechnungsnummer von Stripe. Fehlt bei Entwürfen. */
  number: string | null;
  issuedAt: string | null;
  total: number;
  currency: string;
  status: string;
  paid: boolean;
  description: string | null;
  /** Stripes eigene Ansicht der Rechnung, für Zahlungsbelege und Rückfragen. */
  hostedUrl: string | null;
  /** Ob ein PDF abrufbar ist — Entwürfe haben noch keines. */
  hasPdf: boolean;
}

export interface CompanySearchResultItem {
  name: string;
  registerNumber?: string;
  address?: { street?: string; zip?: string; city?: string };
}

export interface CompanySearchResult {
  enabled: boolean;
  results: CompanySearchResultItem[];
}

@Injectable()
export class EventBillingService {
  private readonly logger = new Logger(EventBillingService.name);

  constructor(
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    private readonly organizationsService: OrganizationsService,
    private readonly emailService: EmailService,
    private readonly platformSettingsService: PlatformSettingsService,
    private readonly stripeService: StripeService,
    private readonly configService: ConfigService,
    private readonly cancellationService: EventUnlockCancellationService,
    private readonly billingAudit: BillingAuditService,
  ) {}

  private async getOrganization(organizationId: string): Promise<Organization> {
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
    });
    if (!organization) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.ORGANIZATION_NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }
    return organization;
  }

  private async getEventInOrg(
    organizationId: string,
    eventId: string,
  ): Promise<Event> {
    const event = await this.eventRepository.findOne({
      where: { id: eventId, organizationId },
    });
    if (!event) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.EVENT_NOT_FOUND,
        message: 'Event nicht gefunden',
      });
    }
    return event;
  }

  /**
   * Hat diese Organisation schon einmal eine Veranstaltung bezahlt? Der
   * Erstveranstaltungs-Rabatt haengt daran. Erlassene Veranstaltungen
   * ("waived") zaehlen bewusst nicht mit: wer nie etwas gezahlt hat, ist
   * beim ersten Kauf noch Neukunde.
   */
  private async hasBilledEventBefore(
    organizationId: string,
    currentEventId: string,
  ): Promise<boolean> {
    const count = await this.eventRepository
      .createQueryBuilder('event')
      /* Auch geloeschte zaehlen. Sonst liesse sich der
         Erstveranstalter-Nachlass beliebig oft holen, indem man die
         bezahlte Veranstaltung hinterher loescht. */
      .withDeleted()
      .where('event.organizationId = :organizationId', { organizationId })
      .andWhere('event.id != :currentEventId', { currentEventId })
      .andWhere('event.billingStatus IN (:...statuses)', {
        statuses: [...EVENT_PAID_BILLING_STATUSES],
      })
      .getCount();
    return count > 0;
  }

  /** Tageswechsel der Abrechnung, siehe countBillableDays. */
  private get businessDayStartHour(): number {
    return normalizeBusinessDayStartHour(
      this.configService.get<number>('billing.businessDayStartHour'),
    );
  }

  /**
   * Preis einer Veranstaltung: Tagespreis mal Veranstaltungstage, davon der
   * hoechste zutreffende Nachlass.
   *
   * Die beiden Nachlaesse werden nicht gestapelt. Ein manuell hinterlegter
   * Sonderpreis und der automatische Erstveranstaltungs-Rabatt haben beide
   * denselben Zweck, und multipliziert ergaeben sie Betraege, die niemand
   * mehr vorhersagen kann.
   */
  private computePrice(
    organization: Organization,
    event: Event,
    isFirstBilledEvent: boolean,
  ): EventPrice {
    const defaultPrice = this.configService.get<number>(
      'billing.eventPriceEur',
      25,
    );
    const pricePerDay =
      organization.eventPriceOverride !== null &&
      organization.eventPriceOverride !== undefined
        ? Number(organization.eventPriceOverride)
        : defaultPrice;

    const businessDayStartHour = this.businessDayStartHour;
    const days = countBillableDays(
      event.startDate,
      event.endDate,
      organization.settings?.timezone || 'Europe/Berlin',
      businessDayStartHour,
    );
    const price = Math.round(pricePerDay * days * 100) / 100;

    const discountStillValid =
      !organization.discountValidUntil ||
      new Date(organization.discountValidUntil) >= new Date();
    const organizationPercent =
      discountStillValid && organization.discountPercent
        ? Number(organization.discountPercent)
        : 0;

    const firstEventPercent = isFirstBilledEvent
      ? this.configService.get<number>('billing.firstEventDiscountPercent', 20)
      : 0;

    const discountPercent = Math.max(organizationPercent, firstEventPercent);
    let discountReason: DiscountReason = null;
    if (discountPercent > 0) {
      discountReason =
        organizationPercent >= firstEventPercent
          ? 'organization'
          : 'first-event';
    }

    const finalPrice =
      Math.round(price * (1 - discountPercent / 100) * 100) / 100;

    return {
      pricePerDay,
      days,
      businessDayStartHour,
      price,
      discountPercent,
      discountReason,
      finalPrice,
    };
  }

  /** Preis inklusive der Abfrage, ob es die erste bezahlte Veranstaltung ist. */
  private async resolvePrice(
    organization: Organization,
    event: Event,
  ): Promise<EventPrice> {
    const isFirstBilledEvent = !(await this.hasBilledEventBefore(
      organization.id,
      event.id,
    ));
    return this.computePrice(organization, event, isFirstBilledEvent);
  }

  /**
   * Was eine Veranstaltung mit diesem Zeitraum kosten wuerde — bevor es
   * sie gibt.
   *
   * Der Preis stand bisher erst im Bezahldialog, also im letzten Schritt.
   * Ein Kunde richtete zu viert einen ganzen Abend lang ein und bemerkte
   * "fast durch Zufall", dass pro Tag gezahlt wird. Dieselbe Rechnung wie
   * beim echten Preis, damit die Vorschau nicht etwas anderes sagt als
   * die Rechnung.
   *
   * Ohne Veranstaltungs-Id zaehlt fuer den Erstveranstalter-Nachlass, ob
   * die Organisation ueberhaupt schon einmal bezahlt hat.
   */
  async previewPrice(
    organizationId: string,
    startDate: string,
    endDate: string | undefined,
    user: User,
  ): Promise<EventPricePreview> {
    await this.organizationsService.checkPermission(
      organizationId,
      user,
      'events',
    );

    const organization = await this.getOrganization(organizationId);
    const timeZone = organization.settings?.timezone || 'Europe/Berlin';
    /* Die Rechnung braucht vom Ereignis nur den Zeitraum. Eine leere Id
       schliesst nichts aus, weil es hier noch nichts auszuschliessen gibt.
       Das Formular schickt reine Daten; die gelten als Mitternacht in der
       Zeitzone der Organisation, wie die gespeicherte Veranstaltung. */
    const entwurf = {
      startDate: parseEventDateInput(startDate, timeZone),
      endDate: parseEventDateInput(endDate || startDate, timeZone),
    } as Event;

    const istErste = !(await this.hasBilledEventBefore(
      organizationId,
      NICHTS_AUSSCHLIESSEN,
    ));

    return {
      ...this.computePrice(organization, entwurf, istErste),
      /* Mitgeliefert, damit die Oberflaeche "kostenlos ausprobieren" mit
         der tatsaechlichen Grenze beschriften kann statt mit einer
         zweiten, irgendwann abweichenden 25. */
      testEventMaxOrders: this.configService.get<number>(
        'billing.testEventMaxOrders',
        25,
      ),
    };
  }

  /**
   * Fuer eine bezahlte oder bestellte Veranstaltung gilt, was beim
   * Freischalten berechnet wurde — nicht, was die heutige Regel ergaebe.
   * Sonst zeigte eine nach Kalendertagen bezahlte Veranstaltung nach dem
   * Wechsel auf Geschaeftstage ploetzlich weniger Tage als bezahlt.
   */
  private withChargedValues(price: EventPrice, event: Event): EventPrice {
    if (!EVENT_PAID_BILLING_STATUSES.includes(event.billingStatus)) {
      return price;
    }
    const days = event.billedDays ?? price.days;
    const finalPrice =
      event.priceCharged !== null && event.priceCharged !== undefined
        ? Number(event.priceCharged)
        : price.finalPrice;
    return {
      ...price,
      days,
      price: Math.round(price.pricePerDay * days * 100) / 100,
      finalPrice,
    };
  }

  async getBillingInfo(
    organizationId: string,
    eventId: string,
    user: User,
  ): Promise<EventBillingInfo> {
    await this.organizationsService.checkPermission(
      organizationId,
      user,
      'events',
    );

    const event = await this.getEventInOrg(organizationId, eventId);
    const organization = await this.getOrganization(organizationId);
    const price = this.withChargedValues(
      await this.resolvePrice(organization, event),
      event,
    );

    return {
      ...price,
      onlinePaymentAvailable: this.stripeService.isConfigured,
      billingMode: organization.billingMode,
      billingStatus: event.billingStatus,
      organizationName: organization.name,
      billingEmail: organization.billingEmail,
      billingAddress: organization.billingAddress,
      paidAt: event.paidAt ? new Date(event.paidAt).toISOString() : null,
      priceCharged:
        event.priceCharged !== null && event.priceCharged !== undefined
          ? Number(event.priceCharged)
          : null,
      cancellation: await this.cancellationService.describe(
        event,
        organization,
      ),
      lastCancellation: await this.cancellationService.lastCancellation(
        event.id,
      ),
    };
  }

  async orderInvoice(
    organizationId: string,
    eventId: string,
    dto: OrderInvoiceDto,
    user: User,
  ): Promise<Event> {
    await this.organizationsService.checkRole(
      organizationId,
      user,
      OrganizationRole.ADMIN,
    );

    const event = await this.getEventInOrg(organizationId, eventId);
    const organization = await this.getOrganization(organizationId);

    if (isEventBillingUnlocked(event.billingStatus)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.EVENT_ALREADY_PAID,
        message: 'Veranstaltung ist bereits freigeschaltet',
      });
    }

    if (organization.billingMode !== 'invoice') {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.ONLINE_PAYMENT_COMING_SOON,
        message: 'Online-Zahlung folgt in Kürze',
      });
    }

    const { finalPrice, days } = await this.resolvePrice(organization, event);

    organization.billingEmail = dto.billingEmail;
    organization.billingAddress = {
      ...dto.billingAddress,
      name: dto.billingName,
      country: organization.billingAddress?.country || 'DE',
    };
    await this.organizationRepository.save(organization);

    event.billingStatus = 'invoice';
    // Server-side computed — never trust a client-supplied price.
    event.priceCharged = finalPrice;
    event.billedDays = days;
    // Fuer die Stornofrist: der Beginn, wie er beim Bestellen stand.
    event.unlockedStartDate = event.startDate;
    await this.eventRepository.save(event);

    this.logger.log(
      `Event ${event.id} (org ${organizationId}) ordered auf Rechnung, price_charged=${finalPrice}`,
    );

    // Best-effort admin notification — failures are only logged, never block
    // the order-invoice flow that already succeeded above.
    try {
      await this.notifyAdminOfEventOrdered(
        organization,
        event,
        finalPrice,
        'invoice',
      );
    } catch (error) {
      this.logger.warn(
        `Failed to send admin event-ordered notification: ${(error as Error).message}`,
      );
    }

    return event;
  }

  /**
   * Sends the "event ordered auf Rechnung" notice to the configured admin
   * notification address. Silently does nothing if the toggle is off or no
   * address is configured anywhere.
   */
  private async notifyAdminOfEventOrdered(
    organization: Organization,
    event: Event,
    priceCharged: number,
    paymentMethod: 'invoice' | 'stripe',
  ): Promise<void> {
    /* Derselbe Schalter fuer beide Wege: aus Betreibersicht ist es ein
       Ereignis — jemand hat eine Veranstaltung gekauft. Wie bezahlt
       wurde, steht in der Mail, nicht in den Einstellungen. */
    const notifyEmail =
      await this.platformSettingsService.resolveNotificationTarget(
        'eventOrdered',
      );
    if (!notifyEmail) {
      return;
    }

    await this.emailService.sendAdminEventOrderedNotification({
      to: notifyEmail,
      organizationName: organization.name,
      eventName: event.name,
      eventDate: event.startDate,
      priceCharged,
      paymentMethod,
      billingAddress: {
        name: organization.billingAddress?.name,
        company: organization.billingAddress?.company,
        street: organization.billingAddress?.street ?? '',
        zip: organization.billingAddress?.zip ?? '',
        city: organization.billingAddress?.city ?? '',
        country: organization.billingAddress?.country ?? '',
      },
    });
  }

  /**
   * Eine Stripe-Zahlungsseite fuer die Freischaltung anlegen.
   *
   * Der Betrag wird hier gerechnet, nicht vom Client uebernommen — sonst
   * koennte jeder Aufrufer seinen eigenen Preis vorschlagen.
   */
  async createStripeCheckout(
    organizationId: string,
    eventId: string,
    user: User,
  ): Promise<{ checkoutUrl: string }> {
    await this.organizationsService.checkRole(
      organizationId,
      user,
      OrganizationRole.ADMIN,
    );

    const event = await this.getEventInOrg(organizationId, eventId);
    const organization = await this.getOrganization(organizationId);

    if (isEventBillingUnlocked(event.billingStatus)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.EVENT_ALREADY_PAID,
        message: 'Veranstaltung ist bereits freigeschaltet',
      });
    }

    const price = await this.resolvePrice(organization, event);
    const currency = organization.settings?.currency || 'EUR';

    const customerId = await this.stripeService.ensureCustomer({
      existingCustomerId: organization.stripeCustomerId,
      organizationId: organization.id,
      organizationName: organization.name,
      email: organization.billingEmail ?? user.email,
    });

    if (customerId !== organization.stripeCustomerId) {
      organization.stripeCustomerId = customerId;
      await this.organizationRepository.save(organization);
    }

    const appUrl =
      this.configService.get<string>('APP_URL') || 'http://localhost:3001';
    const hour = price.businessDayStartHour;
    const dayLabel = `${
      price.days === 1
        ? '1 Veranstaltungstag'
        : `${price.days} Veranstaltungstage`
    } (${hour} bis ${hour} Uhr)`;

    const session = await this.stripeService.createCheckoutSession({
      customerId,
      // Erst runden, dann in Cent — sonst macht die Gleitkommadarstellung aus
      // 24,99 gelegentlich 2498.
      amountInCents: Math.round(price.finalPrice * 100),
      currency,
      productName: `Freischaltung · ${event.name}`,
      productDescription: dayLabel,
      successUrl: `${appUrl}/events?payment=success&eventId=${event.id}`,
      cancelUrl: `${appUrl}/events?payment=cancelled&eventId=${event.id}`,
      /* Die Tage reisen mit: bezahlt wird spaeter vielleicht erst, wenn die
         Veranstaltung schon anders liegt, und festgehalten werden soll,
         wofuer diese Sitzung den Betrag verlangt hat. */
      metadata: {
        eventId: event.id,
        organizationId: organization.id,
        days: String(price.days),
      },
      // Derselbe Preis fuer dieselbe Veranstaltung ergibt dieselbe Sitzung.
      // Aendert sich der Preis, weil die Veranstaltung laenger wurde, ist es
      // bewusst eine neue.
      // Die Tage stehen mit im Schluessel, weil sie in der Beschreibung
      // stehen — gleicher Schluessel mit anderen Angaben lehnt Stripe ab.
      idempotencyKey: `event-checkout:${event.id}:${price.finalPrice}:${price.days}d`,
    });

    event.billingStatus = 'pending';
    event.stripeCheckoutSessionId = session.id;
    await this.eventRepository.save(event);

    this.logger.log(
      `Stripe checkout ${session.id} created for event ${event.id} (${price.finalPrice} ${currency})`,
    );

    return { checkoutUrl: session.url };
  }

  /**
   * Eine abgeschlossene Stripe-Zahlung verbuchen.
   *
   * Wird sowohl vom Webhook als auch von der Rueckkehr aus dem Browser
   * aufgerufen und muss deshalb mehrfach ausgehalten werden: eine bereits
   * bezahlte Veranstaltung wird stillschweigend uebergangen, statt einen
   * Fehler zu werfen, den der Webhook dann endlos wiederholen wuerde.
   */
  async settleStripePayment(sessionId: string): Promise<Event | null> {
    const session = await this.stripeService.getCheckoutSession(sessionId);

    if (session.payment_status !== 'paid') {
      this.logger.warn(
        `Stripe session ${sessionId} ist nicht bezahlt (${session.payment_status})`,
      );
      return null;
    }

    const eventId = session.metadata?.eventId;
    if (!eventId) {
      this.logger.warn(
        `Stripe session ${sessionId} ohne eventId in den Metadaten`,
      );
      return null;
    }

    const event = await this.eventRepository.findOne({
      where: { id: eventId },
    });
    if (!event) {
      this.logger.warn(
        `Stripe session ${sessionId} verweist auf unbekanntes Event ${eventId}`,
      );
      return null;
    }

    if (isEventBillingUnlocked(event.billingStatus)) {
      if (event.stripeCheckoutSessionId !== session.id) {
        /* Bezahlt, aber die Veranstaltung war schon ueber einen anderen Weg
           freigeschaltet (zweite Zahlungsseite, auf Rechnung, erlassen).
           Das Geld ist da und gehoert zurueck — das kann nur der Betreiber
           entscheiden. */
        await this.alertUnassignedPayment(event, session);
      }
      return event;
    }

    /* Diese Zahlung wurde schon storniert und erstattet. Stripe wiederholt
       Webhooks, und bei Lastschrift kommt die Erfolgsmeldung Tage spaeter —
       sie darf eine stornierte Freischaltung nicht wieder aufleben lassen. */
    if (await this.cancellationService.wasCheckoutCancelled(session.id)) {
      this.logger.warn(
        `Stripe session ${sessionId} gehört zu einer stornierten Freischaltung — übergangen`,
      );
      return event;
    }

    const bezahltAm = new Date();
    const betrag = (session.amount_total ?? 0) / 100;
    const organization = await this.organizationRepository.findOne({
      where: { id: event.organizationId },
    });
    const tage = this.daysOfCheckout(
      session.metadata?.days,
      event,
      organization,
    );

    /* Bedingtes Update statt Lesen-und-dann-Schreiben: der Webhook und die
       Rueckkehr aus dem Checkout treffen regelmaessig in derselben Sekunde
       ein. Beide laesen 'none', beide schrieben 'paid' — und beide
       schickten eine Mail. So gewinnt genau einer die Zeile, und nur wer
       sie gewonnen hat, benachrichtigt. */
    const ergebnis = await this.eventRepository.update(
      {
        id: event.id,
        billingStatus: Not(In([...EVENT_UNLOCKED_BILLING_STATUSES])),
      },
      {
        billingStatus: 'paid',
        paidAt: bezahltAm,
        stripeCheckoutSessionId: session.id,
        priceCharged: betrag,
        billedDays: tage,
        unlockedStartDate: event.startDate,
      },
    );

    if (!ergebnis.affected) {
      // Ein anderer Aufruf war schneller — dessen Stand gilt.
      return this.eventRepository.findOne({ where: { id: event.id } });
    }

    /* Spaet eingegangene Zahlung (z. B. Lastschrift einer frueheren
       Zahlungsseite), waehrend schon eine neue Zahlungsseite offen war:
       die neue schliessen, damit niemand ein zweites Mal bezahlt. */
    const andereSitzung =
      event.billingStatus === 'pending' &&
      event.stripeCheckoutSessionId &&
      event.stripeCheckoutSessionId !== session.id
        ? event.stripeCheckoutSessionId
        : null;
    if (andereSitzung) {
      try {
        await this.stripeService.expireCheckoutSession(andereSitzung);
      } catch (error) {
        this.logger.warn(
          `Offene Zahlungsseite ${andereSitzung} nicht geschlossen: ${(error as Error).message}`,
        );
      }
    }

    event.billingStatus = 'paid';
    event.paidAt = bezahltAm;
    event.stripeCheckoutSessionId = session.id;
    event.priceCharged = betrag;
    event.billedDays = tage;
    event.unlockedStartDate = event.startDate;

    this.logger.log(
      `Event ${event.id} bezahlt über Stripe (${event.priceCharged})`,
    );

    // Best-effort wie beim Rechnungsweg: eine gescheiterte Mail darf eine
    // verbuchte Zahlung nicht zurueckdrehen.
    try {
      if (organization) {
        await this.notifyAdminOfEventOrdered(
          organization,
          event,
          betrag,
          'stripe',
        );
      }
    } catch (error) {
      this.logger.warn(
        `Failed to send admin event-paid notification: ${(error as Error).message}`,
      );
    }

    return event;
  }

  /**
   * Eine bezahlte Checkout-Sitzung, die keine Freischaltung (mehr) bewirkt:
   * Protokoll und Mail an den Betreiber, einmal je Sitzung.
   */
  private async alertUnassignedPayment(
    event: Event,
    session: {
      id: string;
      amount_total: number | null;
      currency: string | null;
    },
  ): Promise<void> {
    try {
      if (
        await this.billingAudit.hasEntryWithDetail(
          AdminAction.EVENT_DUPLICATE_PAYMENT,
          'sessionId',
          session.id,
        )
      ) {
        return;
      }
      const betrag = (session.amount_total ?? 0) / 100;
      this.logger.error(
        `Zahlung ${session.id} (${betrag}) für Event ${event.id} ohne Wirkung — Event ist bereits ${event.billingStatus}`,
      );
      await this.billingAudit.record({
        action: AdminAction.EVENT_DUPLICATE_PAYMENT,
        organizationId: event.organizationId,
        eventId: event.id,
        details: {
          sessionId: session.id,
          amount: betrag,
          currency: (session.currency ?? 'eur').toUpperCase(),
          billingStatus: event.billingStatus,
          activeSessionId: event.stripeCheckoutSessionId,
        },
      });
      const to = await this.platformSettingsService.resolvePlatformAdminEmail();
      if (!to) return;
      const organization = await this.organizationRepository.findOne({
        where: { id: event.organizationId },
      });
      await this.emailService.sendAdminBillingAlert({
        to,
        subject: 'Zahlung ohne Freischaltung eingegangen',
        intro:
          'Über Stripe ist eine Zahlung für eine Veranstaltung eingegangen, die bereits freigeschaltet war. Die Zahlung schaltet nichts frei.',
        rows: [
          ['Organisation', organization?.name ?? event.organizationId],
          ['Veranstaltung', event.name],
          [
            'Betrag',
            new Intl.NumberFormat('de-DE', {
              style: 'currency',
              currency: (session.currency ?? 'eur').toUpperCase(),
            }).format(betrag),
          ],
          ['Status', event.billingStatus],
          ['Checkout-Sitzung', session.id],
        ],
        todo: {
          title: 'Bitte prüfen und erstatten',
          text: 'Die doppelte Zahlung im Stripe-Dashboard erstatten und die Organisation informieren.',
        },
      });
    } catch (error) {
      this.logger.warn(
        `Hinweis auf Zahlung ohne Freischaltung nicht gesendet: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Fuer welche Tage eine Stripe-Sitzung bezahlt wurde. Neue Sitzungen
   * tragen die Zahl in den Metadaten. Fehlt sie, stammt die Sitzung von vor
   * der Umstellung auf Geschaeftstage — ihr Betrag wurde nach Kalendertagen
   * berechnet, also werden auch die so gezaehlt.
   */
  private daysOfCheckout(
    metadataDays: string | undefined,
    event: Event,
    organization: Organization | null,
  ): number {
    const fromMetadata = Number(metadataDays);
    if (Number.isInteger(fromMetadata) && fromMetadata >= 1) {
      return fromMetadata;
    }
    return countCalendarDays(
      event.startDate,
      event.endDate,
      organization?.settings?.timezone || 'Europe/Berlin',
    );
  }

  /**
   * Nach der Rueckkehr aus dem Stripe-Checkout nachsehen, ob die Zahlung
   * durch ist. Der Webhook erledigt dasselbe, kommt aber gelegentlich erst
   * Sekunden spaeter — und so lange soll niemand auf eine Seite starren, die
   * "noch nicht bezahlt" sagt, obwohl gerade bezahlt wurde.
   */
  async syncStripePayment(
    organizationId: string,
    eventId: string,
    user: User,
  ): Promise<EventBillingInfo> {
    await this.organizationsService.checkPermission(
      organizationId,
      user,
      'events',
    );

    const event = await this.getEventInOrg(organizationId, eventId);
    if (event.stripeCheckoutSessionId && event.billingStatus === 'pending') {
      try {
        await this.settleStripePayment(event.stripeCheckoutSessionId);
      } catch (error) {
        this.logger.warn(
          `Stripe-Abgleich für Event ${eventId} fehlgeschlagen: ${(error as Error).message}`,
        );
      }
    }

    return this.getBillingInfo(organizationId, eventId, user);
  }

  /**
   * Die Rechnungen der Organisation.
   *
   * Ausgestellt werden sie von Stripe: Nummer, Datum und PDF stammen von
   * dort, wir spiegeln nichts in die eigene Datenbank. Damit gibt es genau
   * eine Wahrheit und keinen Abgleich, der auseinanderlaufen kann.
   *
   * Ohne Stripe-Kunden hat die Organisation noch nie online bezahlt — dann
   * ist die Liste leer, und das ist kein Fehler.
   */
  async listInvoices(
    organizationId: string,
    user: User,
  ): Promise<OrganizationInvoice[]> {
    await this.organizationsService.checkRole(
      organizationId,
      user,
      OrganizationRole.ADMIN,
    );

    const organization = await this.getOrganization(organizationId);
    if (!organization.stripeCustomerId || !this.stripeService.isConfigured) {
      return [];
    }

    const [invoices, creditNotes] = await Promise.all([
      this.stripeService.listInvoices(organization.stripeCustomerId),
      this.stripeService.listCreditNotes(organization.stripeCustomerId),
    ]);

    const rows: OrganizationInvoice[] = invoices.map((invoice) => ({
      id: invoice.id ?? '',
      kind: 'invoice' as const,
      relatedInvoiceNumber: null,
      number: invoice.number ?? null,
      // Stripe zählt in Sekunden, der Rest der Anwendung in Millisekunden.
      issuedAt: invoice.created
        ? new Date(invoice.created * 1000).toISOString()
        : null,
      total: (invoice.total ?? 0) / 100,
      currency: (invoice.currency ?? 'eur').toUpperCase(),
      status: invoice.status ?? 'draft',
      paid: invoice.status === 'paid',
      description:
        invoice.lines?.data?.[0]?.description ?? invoice.description ?? null,
      hostedUrl: invoice.hosted_invoice_url ?? null,
      hasPdf: !!invoice.invoice_pdf,
    }));

    /* Stornorechnungen sind bei Stripe Gutschriften zu einer Rechnung. Sie
       stehen in derselben Liste, weil sie fuer die Buchhaltung dazugehoeren:
       wer die Rechnung ablegt, muss auch ihre Aufhebung finden. */
    for (const note of creditNotes) {
      const invoice =
        note.invoice && typeof note.invoice !== 'string' ? note.invoice : null;
      rows.push({
        id: note.id,
        kind: 'credit_note',
        relatedInvoiceNumber: invoice?.number ?? null,
        number: note.number ?? null,
        issuedAt: note.created
          ? new Date(note.created * 1000).toISOString()
          : null,
        total: (note.total ?? 0) / 100,
        currency: (note.currency ?? 'eur').toUpperCase(),
        status: note.status ?? 'issued',
        paid: false,
        description: note.memo ?? null,
        hostedUrl: null,
        hasPdf: !!note.pdf,
      });
    }

    // Neueste zuerst, Rechnungen und Gutschriften gemischt.
    return rows.sort((a, b) =>
      (b.issuedAt ?? '').localeCompare(a.issuedAt ?? ''),
    );
  }

  /**
   * Ein einzelnes Rechnungs-PDF, geprüft und weitergereicht.
   *
   * Die Zugehörigkeit wird gegen den Stripe-Kunden der Organisation geprüft.
   * Ohne das könnte ein Administrator mit einer fremden Rechnungs-ID die
   * Rechnung einer anderen Organisation abrufen — die IDs sind zwar nicht
   * zu erraten, aber Unerratbarkeit ist keine Berechtigung.
   */
  async getInvoicePdf(
    organizationId: string,
    invoiceId: string,
    user: User,
  ): Promise<{ filename: string; content: Buffer }> {
    await this.organizationsService.checkRole(
      organizationId,
      user,
      OrganizationRole.ADMIN,
    );

    const organization = await this.getOrganization(organizationId);

    /* Gutschriften (Stornorechnungen) tragen bei Stripe das Praefix cn_ —
       derselbe Weg, dieselbe Pruefung der Zugehoerigkeit. */
    const document = invoiceId.startsWith('cn_')
      ? await this.stripeService.getCreditNote(invoiceId).then((note) => ({
          id: note.id,
          number: note.number,
          customer: note.customer,
          pdf: note.pdf,
        }))
      : await this.stripeService.getInvoice(invoiceId).then((invoice) => ({
          id: invoice.id ?? invoiceId,
          number: invoice.number,
          customer: invoice.customer,
          pdf: invoice.invoice_pdf,
        }));

    const customerId =
      typeof document.customer === 'string'
        ? document.customer
        : document.customer?.id;
    if (
      !organization.stripeCustomerId ||
      customerId !== organization.stripeCustomerId
    ) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.INVOICE_NOT_FOUND,
        message: 'Rechnung nicht gefunden',
      });
    }

    if (!document.pdf) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.INVOICE_PDF_NOT_AVAILABLE,
        message: 'Für diese Rechnung liegt noch kein PDF vor',
      });
    }

    const content = await this.stripeService.fetchInvoicePdf(document.pdf);
    return { filename: `${document.number ?? document.id}.pdf`, content };
  }

  async companySearch(
    organizationId: string,
    query: string,
    user: User,
  ): Promise<CompanySearchResult> {
    await this.organizationsService.checkPermission(
      organizationId,
      user,
      'events',
    );

    const apiKey = this.configService.get<string>('billing.openRegisterApiKey');
    if (!apiKey) {
      return { enabled: false, results: [] };
    }

    const trimmedQuery = query?.trim();
    if (!trimmedQuery) {
      return { enabled: true, results: [] };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const url = `https://api.openregister.de/v1/autocomplete/company?query=${encodeURIComponent(trimmedQuery)}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger.warn(
          `OpenRegister company search failed: HTTP ${response.status}`,
        );
        return { enabled: true, results: [] };
      }

      const body = (await response.json()) as {
        results?: Array<{
          name?: string;
          register_number?: string;
          address?: { street?: string; postal_code?: string; city?: string };
        }>;
      };

      const results: CompanySearchResultItem[] = (body.results ?? []).map(
        (r) => ({
          name: r.name ?? '',
          registerNumber: r.register_number,
          address: r.address
            ? {
                street: r.address.street,
                zip: r.address.postal_code,
                city: r.address.city,
              }
            : undefined,
        }),
      );

      return { enabled: true, results };
    } catch (error) {
      this.logger.warn(
        `OpenRegister company search errored: ${(error as Error).message}`,
      );
      return { enabled: true, results: [] };
    } finally {
      clearTimeout(timeout);
    }
  }
}
