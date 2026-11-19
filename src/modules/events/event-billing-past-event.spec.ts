import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { EventBillingService } from './event-billing.service';
import { BillingAuditService } from './billing-audit.service';
import { StripeInvoiceService } from './stripe-invoice.service';
import { Event } from '../../database/entities/event.entity';
import { Organization } from '../../database/entities/organization.entity';
import { User } from '../../database/entities';
import { OrganizationsService } from '../organizations/organizations.service';
import { StripeService } from '../stripe/stripe.service';
import { EventUnlockCancellationService } from './event-unlock-cancellation.service';
import { EmailService } from '../email/email.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { EventPhaseService } from './event-phase.service';
import { DEFAULT_EVENT_PHASE_SETTINGS } from '../../common/utils/event-phase.util';
import { ErrorReasons } from '../../common/constants/error-codes';
import { OrderInvoiceDto } from './dto/event-billing.dto';

/**
 * Eine Veranstaltung, deren letzter Geschaeftstag vorbei ist, laesst sich
 * nicht mehr kaufen (Online und auf Rechnung). Laufende und kuenftige schon.
 */
describe('EventBillingService – Kauf nach dem Ende', () => {
  const organization = {
    id: 'org-1',
    name: 'Musikverein',
    eventPriceOverride: null,
    discountPercent: null,
    discountValidUntil: null,
    billingMode: 'invoice',
    billingEmail: 'kasse@example.com',
    billingAddress: null,
    settings: { timezone: 'Europe/Berlin' },
  } as unknown as Organization;

  const user = { id: 'user-1', email: 'u@example.com' } as User;

  function setup(
    options: {
      event?: Partial<Event>;
      businessDayStartHour?: number;
      billedBefore?: boolean;
    } = {},
  ) {
    const event = {
      id: 'event-1',
      organizationId: organization.id,
      name: 'Sommernacht',
      startDate: new Date('2026-10-17T20:00+02:00'),
      endDate: new Date('2026-10-18T02:00+02:00'),
      billingStatus: 'none',
      priceCharged: null,
      billedDays: null,
      ...options.event,
    } as Event;

    const queryBuilder = {
      withDeleted: () => queryBuilder,
      where: () => queryBuilder,
      andWhere: () => queryBuilder,
      getCount: () => Promise.resolve(options.billedBefore === false ? 0 : 1),
    };
    const eventRepository = {
      findOne: jest.fn().mockResolvedValue(event),
      save: jest.fn((e: Event) => Promise.resolve(e)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: () => queryBuilder,
    };
    const organizationRepository = {
      findOne: jest.fn().mockResolvedValue(organization),
      save: jest.fn((o: Organization) => Promise.resolve(o)),
    };
    const config: Record<string, unknown> = {
      'billing.eventPriceEur': 25,
      'billing.firstEventDiscountPercent': 20,
      'billing.testEventMaxOrders': 25,
      'billing.businessDayStartHour': options.businessDayStartHour,
    };
    const configService = {
      get: (key: string, fallback?: unknown) => config[key] ?? fallback,
    } as unknown as ConfigService;
    const stripeService = {
      isConfigured: true,
      ensureCustomer: jest.fn().mockResolvedValue('cus_1'),
      createCheckoutSession: jest
        .fn()
        .mockResolvedValue({ id: 'cs_1', url: 'https://stripe.test/cs_1' }),
      getCheckoutSession: jest.fn(),
    };

    const service = new EventBillingService(
      eventRepository as unknown as Repository<Event>,
      organizationRepository as unknown as Repository<Organization>,
      {
        checkPermission: jest.fn(),
        checkRole: jest.fn(),
      } as unknown as OrganizationsService,
      {} as EmailService,
      {
        resolveNotificationTarget: jest.fn().mockResolvedValue(null),
      } as unknown as PlatformSettingsService,
      stripeService as unknown as StripeService,
      configService,
      {
        describe: jest.fn().mockResolvedValue({
          allowed: false,
          deadline: null,
          timezone: 'Europe/Berlin',
          blockedReason: 'not_paid',
        }),
        lastCancellation: jest.fn().mockResolvedValue(null),
        wasCheckoutCancelled: jest.fn().mockResolvedValue(false),
      } as unknown as EventUnlockCancellationService,
      {
        record: jest.fn(),
        hasEntryWithDetail: jest.fn().mockResolvedValue(false),
      } as unknown as BillingAuditService,
      {
        isAvailable: false,
        daysUntilDue: () => 14,
      } as unknown as StripeInvoiceService,
      undefined,
      undefined,
      {
        settings: DEFAULT_EVENT_PHASE_SETTINGS,
      } as unknown as EventPhaseService,
    );

    return { service, event, eventRepository, stripeService };
  }

  // Veranstaltung 17.10. 20 Uhr bis 18.10. 2 Uhr: letzter Geschaeftstag
  // endet am 18.10. um 6 Uhr.
  afterEach(() => jest.useRealTimers());

  async function reasonOf(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
      return null;
    } catch (error) {
      const response = (
        error as { getResponse?: () => unknown }
      ).getResponse?.() as { reason?: unknown } | undefined;
      return response?.reason ?? (error as Error).message;
    }
  }

  const invoiceDto = {
    billingName: 'Musikverein e.V.',
    billingAddress: { street: 'Hauptstr. 1', zip: '12345', city: 'Ort' },
  } as unknown as OrderInvoiceDto;

  it('lehnt den Online-Kauf nach dem Ende ab', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-18T06:00+02:00'));
    const { service, stripeService } = setup();
    expect(
      await reasonOf(service.createStripeCheckout('org-1', 'event-1', user)),
    ).toBe(ErrorReasons.EVENT_OVER_CANNOT_PURCHASE);
    expect(stripeService.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('lehnt den Kauf auf Rechnung nach dem Ende ab', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-20T12:00+01:00'));
    const { service, eventRepository } = setup();
    expect(
      await reasonOf(
        service.orderInvoice('org-1', 'event-1', invoiceDto, user),
      ),
    ).toBe(ErrorReasons.EVENT_OVER_CANNOT_PURCHASE);
    expect(eventRepository.save).not.toHaveBeenCalled();
  });

  it('meldet eventOver in den Abrechnungsangaben', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-18T06:00+02:00'));
    expect(
      (await setup().service.getBillingInfo('org-1', 'event-1', user))
        .eventOver,
    ).toBe(true);
    jest.setSystemTime(new Date('2026-10-18T05:59+02:00'));
    expect(
      (await setup().service.getBillingInfo('org-1', 'event-1', user))
        .eventOver,
    ).toBe(false);
  });

  it('erlaubt den Kauf waehrend der Veranstaltung', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-18T05:59+02:00'));
    const { service } = setup();
    expect(
      await reasonOf(service.createStripeCheckout('org-1', 'event-1', user)),
    ).not.toBe(ErrorReasons.EVENT_OVER_CANNOT_PURCHASE);
  });

  it('erlaubt den Kauf vor der Veranstaltung', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-01T12:00+02:00'));
    const { service } = setup();
    expect(
      await reasonOf(
        service.orderInvoice('org-1', 'event-1', invoiceDto, user),
      ),
    ).not.toBe(ErrorReasons.EVENT_OVER_CANNOT_PURCHASE);
  });
});
