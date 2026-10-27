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

/** Argument des ersten Aufrufs eines Mocks. */
function argOf<T>(mock: jest.Mock, index: number): T {
  return (mock.mock.calls as unknown[][])[0][index] as T;
}

/**
 * Abrechnung nach Geschaeftstagen (6 bis 6 Uhr) — und dass bereits
 * Bezahltes nicht nach der neuen Regel umgerechnet wird.
 */
describe('EventBillingService – Veranstaltungstage', () => {
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
    );

    return { service, event, eventRepository, stripeService };
  }

  it('rechnet eine Nacht bis 2 Uhr als einen Tag', async () => {
    const { service } = setup();
    const info = await service.getBillingInfo('org-1', 'event-1', user);
    expect(info.days).toBe(1);
    expect(info.finalPrice).toBe(25);
    expect(info.businessDayStartHour).toBe(6);
  });

  it('folgt einem konfigurierten Tageswechsel', async () => {
    const { service } = setup({
      businessDayStartHour: 1,
      event: {
        startDate: new Date('2026-10-17T20:00+02:00'),
        endDate: new Date('2026-10-18T02:00+02:00'),
      },
    });
    const info = await service.getBillingInfo('org-1', 'event-1', user);
    expect(info.days).toBe(2);
    expect(info.businessDayStartHour).toBe(1);
  });

  it('Vorschau aus reinen Daten zaehlt wie das Formular', async () => {
    const { service } = setup();
    const preview = await service.previewPrice(
      'org-1',
      '2026-10-23',
      '2026-10-25',
      user,
    );
    expect(preview.days).toBe(3);
    expect(preview.price).toBe(75);

    const single = await service.previewPrice(
      'org-1',
      '2026-10-17',
      undefined,
      user,
    );
    expect(single.days).toBe(1);
  });

  it('haelt die Tage beim Kauf auf Rechnung fest', async () => {
    const { service, eventRepository } = setup();
    await service.orderInvoice(
      'org-1',
      'event-1',
      {
        billingEmail: 'kasse@example.com',
        billingName: 'Musikverein',
        billingAddress: { street: 'Weg 1', zip: '12345', city: 'Ort' },
      } as never,
      user,
    );
    const saved = argOf<Event>(eventRepository.save, 0);
    expect(saved.billedDays).toBe(1);
    expect(saved.priceCharged).toBe(25);
  });

  it('zeigt fuer bezahlte Veranstaltungen die bezahlten Tage, nicht die neu gezaehlten', async () => {
    // Nach Kalendertagen bezahlt: Sa 20 Uhr bis So 2 Uhr = 2 Tage, 50 €.
    const { service } = setup({
      event: { billingStatus: 'paid', priceCharged: 50, billedDays: 2 },
    });
    const info = await service.getBillingInfo('org-1', 'event-1', user);
    expect(info.days).toBe(2);
    expect(info.price).toBe(50);
    expect(info.finalPrice).toBe(50);
  });

  it('gibt Stripe die Tage mit und beschreibt den Tageswechsel', async () => {
    const { service, stripeService } = setup();
    await service.createStripeCheckout('org-1', 'event-1', user);
    const params = argOf<{
      metadata: Record<string, string>;
      productDescription: string;
      amountInCents: number;
    }>(stripeService.createCheckoutSession, 0);
    expect(params.metadata.days).toBe('1');
    expect(params.productDescription).toBe('1 Veranstaltungstag (6 bis 6 Uhr)');
    expect(params.amountInCents).toBe(2500);
  });

  it('uebernimmt beim Verbuchen die Tage der Stripe-Sitzung', async () => {
    const { service, stripeService, eventRepository } = setup({
      event: { billingStatus: 'pending' },
    });
    stripeService.getCheckoutSession.mockResolvedValue({
      id: 'cs_1',
      payment_status: 'paid',
      amount_total: 2500,
      metadata: { eventId: 'event-1', days: '1' },
    });
    await service.settleStripePayment('cs_1');
    expect(argOf<object>(eventRepository.update, 1)).toMatchObject({
      billedDays: 1,
      priceCharged: 25,
    });
  });

  it('Sitzungen von vor der Umstellung zaehlen nach Kalendertagen', async () => {
    const { service, stripeService, eventRepository } = setup({
      event: { billingStatus: 'pending' },
    });
    stripeService.getCheckoutSession.mockResolvedValue({
      id: 'cs_old',
      payment_status: 'paid',
      amount_total: 5000,
      metadata: { eventId: 'event-1' },
    });
    await service.settleStripePayment('cs_old');
    expect(argOf<object>(eventRepository.update, 1)).toMatchObject({
      billedDays: 2,
      priceCharged: 50,
    });
  });
});
