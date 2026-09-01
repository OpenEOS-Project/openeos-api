import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Event } from '../../database/entities/event.entity';
import { Organization, BillingAddress } from '../../database/entities/organization.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { User } from '../../database/entities';
import { ErrorCodes } from '../../common/constants/error-codes';
import { OrganizationsService } from '../organizations/organizations.service';
import { countEventDays } from '../../common/utils/event-schedule.util';
import { StripeService } from '../stripe/stripe.service';
import { EmailService } from '../email/email.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { OrderInvoiceDto } from './dto/event-billing.dto';

/** Woher der gewaehrte Nachlass stammt — die Oberflaeche beschriftet ihn danach. */
export type DiscountReason = 'first-event' | 'organization' | null;

export interface EventPrice {
  /** Preis je Veranstaltungstag, vor Nachlass. */
  pricePerDay: number;
  /** Abgerechnete Veranstaltungstage. */
  days: number;
  /** pricePerDay * days, vor Nachlass. */
  price: number;
  discountPercent: number;
  discountReason: DiscountReason;
  finalPrice: number;
}

export interface EventBillingInfo extends EventPrice {
  /** Ob die Online-Zahlung ueberhaupt zur Verfuegung steht. */
  onlinePaymentAvailable: boolean;
  billingMode: string;
  billingStatus: string;
  organizationName: string;
  billingEmail: string | null;
  billingAddress: BillingAddress | null;
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
  ) {}

  private async getOrganization(organizationId: string): Promise<Organization> {
    const organization = await this.organizationRepository.findOne({ where: { id: organizationId } });
    if (!organization) {
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Organisation nicht gefunden' });
    }
    return organization;
  }

  private async getEventInOrg(organizationId: string, eventId: string): Promise<Event> {
    const event = await this.eventRepository.findOne({ where: { id: eventId, organizationId } });
    if (!event) {
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Event nicht gefunden' });
    }
    return event;
  }

  /**
   * Hat diese Organisation schon einmal eine Veranstaltung bezahlt? Der
   * Erstveranstaltungs-Rabatt haengt daran. Erlassene Veranstaltungen
   * ("waived") zaehlen bewusst nicht mit: wer nie etwas gezahlt hat, ist
   * beim ersten Kauf noch Neukunde.
   */
  private async hasBilledEventBefore(organizationId: string, currentEventId: string): Promise<boolean> {
    const count = await this.eventRepository
      .createQueryBuilder('event')
      .where('event.organizationId = :organizationId', { organizationId })
      .andWhere('event.id != :currentEventId', { currentEventId })
      .andWhere('event.billingStatus IN (:...statuses)', { statuses: ['paid', 'invoice'] })
      .getCount();
    return count > 0;
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
    const defaultPrice = this.configService.get<number>('billing.eventPriceEur', 25);
    const pricePerDay =
      organization.eventPriceOverride !== null && organization.eventPriceOverride !== undefined
        ? Number(organization.eventPriceOverride)
        : defaultPrice;

    const days = countEventDays(event.startDate, event.endDate, organization.settings?.timezone || 'Europe/Berlin');
    const price = Math.round(pricePerDay * days * 100) / 100;

    const discountStillValid =
      !organization.discountValidUntil || new Date(organization.discountValidUntil) >= new Date();
    const organizationPercent =
      discountStillValid && organization.discountPercent ? Number(organization.discountPercent) : 0;

    const firstEventPercent = isFirstBilledEvent
      ? this.configService.get<number>('billing.firstEventDiscountPercent', 20)
      : 0;

    const discountPercent = Math.max(organizationPercent, firstEventPercent);
    let discountReason: DiscountReason = null;
    if (discountPercent > 0) {
      discountReason = organizationPercent >= firstEventPercent ? 'organization' : 'first-event';
    }

    const finalPrice = Math.round(price * (1 - discountPercent / 100) * 100) / 100;

    return { pricePerDay, days, price, discountPercent, discountReason, finalPrice };
  }

  /** Preis inklusive der Abfrage, ob es die erste bezahlte Veranstaltung ist. */
  private async resolvePrice(organization: Organization, event: Event): Promise<EventPrice> {
    const isFirstBilledEvent = !(await this.hasBilledEventBefore(organization.id, event.id));
    return this.computePrice(organization, event, isFirstBilledEvent);
  }

  async getBillingInfo(organizationId: string, eventId: string, user: User): Promise<EventBillingInfo> {
    await this.organizationsService.checkPermission(organizationId, user, 'events');

    const event = await this.getEventInOrg(organizationId, eventId);
    const organization = await this.getOrganization(organizationId);
    const price = await this.resolvePrice(organization, event);

    return {
      ...price,
      onlinePaymentAvailable: this.stripeService.isConfigured,
      billingMode: organization.billingMode,
      billingStatus: event.billingStatus,
      organizationName: organization.name,
      billingEmail: organization.billingEmail,
      billingAddress: organization.billingAddress,
    };
  }

  async orderInvoice(
    organizationId: string,
    eventId: string,
    dto: OrderInvoiceDto,
    user: User,
  ): Promise<Event> {
    await this.organizationsService.checkRole(organizationId, user, OrganizationRole.ADMIN);

    const event = await this.getEventInOrg(organizationId, eventId);
    const organization = await this.getOrganization(organizationId);

    if (['paid', 'invoice', 'waived'].includes(event.billingStatus)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Veranstaltung ist bereits freigeschaltet',
      });
    }

    if (organization.billingMode !== 'invoice') {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Online-Zahlung folgt in Kürze',
      });
    }

    const { finalPrice } = await this.resolvePrice(organization, event);

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
    await this.eventRepository.save(event);

    this.logger.log(
      `Event ${event.id} (org ${organizationId}) ordered auf Rechnung, price_charged=${finalPrice}`,
    );

    // Best-effort admin notification — failures are only logged, never block
    // the order-invoice flow that already succeeded above.
    try {
      await this.notifyAdminOfEventOrdered(organization, event, finalPrice);
    } catch (error) {
      this.logger.warn(`Failed to send admin event-ordered notification: ${(error as Error).message}`);
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
  ): Promise<void> {
    const notifyEmail = await this.platformSettingsService.resolveNotificationTarget('eventOrdered');
    if (!notifyEmail) {
      return;
    }

    await this.emailService.sendAdminEventOrderedNotification({
      to: notifyEmail,
      organizationName: organization.name,
      eventName: event.name,
      eventDate: event.startDate,
      priceCharged,
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
    await this.organizationsService.checkRole(organizationId, user, OrganizationRole.ADMIN);

    const event = await this.getEventInOrg(organizationId, eventId);
    const organization = await this.getOrganization(organizationId);

    if (['paid', 'invoice', 'waived'].includes(event.billingStatus)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
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

    const appUrl = this.configService.get<string>('APP_URL') || 'http://localhost:3001';
    const dayLabel = price.days === 1 ? '1 Veranstaltungstag' : `${price.days} Veranstaltungstage`;

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
      metadata: { eventId: event.id, organizationId: organization.id },
      // Derselbe Preis fuer dieselbe Veranstaltung ergibt dieselbe Sitzung.
      // Aendert sich der Preis, weil die Veranstaltung laenger wurde, ist es
      // bewusst eine neue.
      idempotencyKey: `event-checkout:${event.id}:${price.finalPrice}`,
    });

    event.billingStatus = 'pending';
    event.stripeCheckoutSessionId = session.id;
    await this.eventRepository.save(event);

    this.logger.log(`Stripe checkout ${session.id} created for event ${event.id} (${price.finalPrice} ${currency})`);

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
      this.logger.warn(`Stripe session ${sessionId} ist nicht bezahlt (${session.payment_status})`);
      return null;
    }

    const eventId = session.metadata?.eventId;
    if (!eventId) {
      this.logger.warn(`Stripe session ${sessionId} ohne eventId in den Metadaten`);
      return null;
    }

    const event = await this.eventRepository.findOne({ where: { id: eventId } });
    if (!event) {
      this.logger.warn(`Stripe session ${sessionId} verweist auf unbekanntes Event ${eventId}`);
      return null;
    }

    if (['paid', 'invoice', 'waived'].includes(event.billingStatus)) {
      return event;
    }

    event.billingStatus = 'paid';
    event.paidAt = new Date();
    event.stripeCheckoutSessionId = session.id;
    event.priceCharged = (session.amount_total ?? 0) / 100;
    await this.eventRepository.save(event);

    this.logger.log(`Event ${event.id} bezahlt über Stripe (${event.priceCharged})`);

    return event;
  }

  /**
   * Nach der Rueckkehr aus dem Stripe-Checkout nachsehen, ob die Zahlung
   * durch ist. Der Webhook erledigt dasselbe, kommt aber gelegentlich erst
   * Sekunden spaeter — und so lange soll niemand auf eine Seite starren, die
   * "noch nicht bezahlt" sagt, obwohl gerade bezahlt wurde.
   */
  async syncStripePayment(organizationId: string, eventId: string, user: User): Promise<EventBillingInfo> {
    await this.organizationsService.checkPermission(organizationId, user, 'events');

    const event = await this.getEventInOrg(organizationId, eventId);
    if (event.stripeCheckoutSessionId && event.billingStatus === 'pending') {
      try {
        await this.settleStripePayment(event.stripeCheckoutSessionId);
      } catch (error) {
        this.logger.warn(`Stripe-Abgleich für Event ${eventId} fehlgeschlagen: ${(error as Error).message}`);
      }
    }

    return this.getBillingInfo(organizationId, eventId, user);
  }

  async companySearch(organizationId: string, query: string, user: User): Promise<CompanySearchResult> {
    await this.organizationsService.checkPermission(organizationId, user, 'events');

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
        this.logger.warn(`OpenRegister company search failed: HTTP ${response.status}`);
        return { enabled: true, results: [] };
      }

      const body = (await response.json()) as {
        results?: Array<{
          name?: string;
          register_number?: string;
          address?: { street?: string; postal_code?: string; city?: string };
        }>;
      };

      const results: CompanySearchResultItem[] = (body.results ?? []).map((r) => ({
        name: r.name ?? '',
        registerNumber: r.register_number,
        address: r.address
          ? { street: r.address.street, zip: r.address.postal_code, city: r.address.city }
          : undefined,
      }));

      return { enabled: true, results };
    } catch (error) {
      this.logger.warn(`OpenRegister company search errored: ${(error as Error).message}`);
      return { enabled: true, results: [] };
    } finally {
      clearTimeout(timeout);
    }
  }
}
