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
import { EmailService } from '../email/email.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { OrderInvoiceDto } from './dto/event-billing.dto';

export interface EventBillingInfo {
  price: number;
  discountPercent: number;
  finalPrice: number;
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

  private computePrice(organization: Organization): {
    price: number;
    discountPercent: number;
    finalPrice: number;
  } {
    const defaultPrice = this.configService.get<number>('billing.eventPriceEur', 25);
    const price =
      organization.eventPriceOverride !== null && organization.eventPriceOverride !== undefined
        ? Number(organization.eventPriceOverride)
        : defaultPrice;

    const discountStillValid =
      !organization.discountValidUntil || new Date(organization.discountValidUntil) >= new Date();
    const discountPercent =
      discountStillValid && organization.discountPercent ? Number(organization.discountPercent) : 0;

    const finalPrice = Math.round(price * (1 - discountPercent / 100) * 100) / 100;

    return { price, discountPercent, finalPrice };
  }

  async getBillingInfo(organizationId: string, eventId: string, user: User): Promise<EventBillingInfo> {
    await this.organizationsService.checkPermission(organizationId, user, 'events');

    const event = await this.getEventInOrg(organizationId, eventId);
    const organization = await this.getOrganization(organizationId);
    const { price, discountPercent, finalPrice } = this.computePrice(organization);

    return {
      price,
      discountPercent,
      finalPrice,
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

    const { finalPrice } = this.computePrice(organization);

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
