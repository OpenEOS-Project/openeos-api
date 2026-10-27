import { EntityManager, Repository } from 'typeorm';
import type Stripe from 'stripe';
import { ConfigService } from '@nestjs/config';

import { Event, EventStatus } from '../../database/entities/event.entity';
import { Organization } from '../../database/entities/organization.entity';
import { Order } from '../../database/entities/order.entity';
import { EventBillingCancellation } from '../../database/entities/event-billing-cancellation.entity';
import { UserOrganization } from '../../database/entities/user-organization.entity';
import { AdminAction } from '../../database/entities/admin-audit-log.entity';
import { User } from '../../database/entities';
import { StripeService } from '../stripe/stripe.service';
import { EmailService } from '../email/email.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { GatewayService } from '../gateway/gateway.service';
import { BillingAuditService } from './billing-audit.service';
import { EventUnlockCancellationService } from './event-unlock-cancellation.service';
import { EventBillingService } from './event-billing.service';
import {
  StripeInvoiceService,
  VAT_EXEMPT_NOTE,
  invoiceSummaryOf,
  snapshotOf,
} from './stripe-invoice.service';

/** expect.objectContaining ohne `any` — fuer verschachtelte Erwartungen. */
const containing = (expected: object): unknown =>
  expect.objectContaining(expected);

const ORG = '00000000-0000-4000-8000-000000000001';
const EVENT_ID = '00000000-0000-4000-8000-0000000000e1';
const BERLIN = 'Europe/Berlin';

function organization(overrides: Partial<Organization> = {}): Organization {
  return {
    id: ORG,
    name: 'Musikverein',
    billingEmail: 'kasse@example.org',
    billingAddress: {
      name: 'Musikverein Harmonie e.V.',
      street: 'Hauptstraße 1',
      zip: '12345',
      city: 'Musterstadt',
      country: 'DE',
    },
    billingMode: 'invoice',
    stripeCustomerId: null,
    invoiceDaysUntilDue: null,
    eventPriceOverride: null,
    discountPercent: null,
    discountValidUntil: null,
    settings: { timezone: BERLIN, currency: 'EUR' },
    ...overrides,
  } as unknown as Organization;
}

function invoicedEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: EVENT_ID,
    organizationId: ORG,
    name: 'Sommerfest',
    startDate: new Date('2026-09-11T15:00:00.000Z'),
    endDate: new Date('2026-09-12T22:00:00.000Z'),
    unlockedStartDate: new Date('2026-09-11T15:00:00.000Z'),
    status: EventStatus.ACTIVE,
    billingStatus: 'invoice',
    paidAt: new Date('2026-08-01T10:00:00.000Z'),
    priceCharged: 40,
    billedDays: 2,
    stripeCheckoutSessionId: null,
    invoicedAt: new Date('2026-08-01T10:00:00.000Z'),
    invoicedBy: null,
    invoiceNote: 'Stripe-Rechnung INV-0007',
    stripeInvoiceId: 'in_1',
    stripeInvoiceNumber: 'INV-0007',
    invoiceStatus: 'open',
    invoiceDueAt: new Date('2026-08-15T00:00:00.000Z'),
    invoicePaidAt: null,
    invoiceHostedUrl: 'https://invoice.stripe.com/i/in_1',
    invoicePdfUrl: 'https://pay.stripe.com/invoice/in_1/pdf',
    deletedAt: null,
    ...overrides,
  } as unknown as Event;
}

function stripeInvoice(
  overrides: Partial<Record<keyof Stripe.Invoice, unknown>> = {},
): Stripe.Invoice {
  return {
    id: 'in_1',
    number: 'INV-0007',
    status: 'open',
    currency: 'eur',
    amount_due: 4000,
    amount_paid: 0,
    amount_remaining: 4000,
    due_date: 1786752000, // 2026-08-15
    hosted_invoice_url: 'https://invoice.stripe.com/i/in_1',
    invoice_pdf: 'https://pay.stripe.com/invoice/in_1/pdf',
    status_transitions: { paid_at: null },
    metadata: { eventId: EVENT_ID, organizationId: ORG, kind: 'event_unlock' },
    ...overrides,
  } as unknown as Stripe.Invoice;
}

function setup(
  options: {
    event?: Event | null;
    organization?: Organization;
    realOrders?: number;
    ownCancellations?: number;
    seen?: boolean;
    configured?: boolean;
    configDays?: number;
    cancellationRow?: Partial<EventBillingCancellation> | null;
  } = {},
) {
  const event = options.event === undefined ? invoicedEvent() : options.event;
  const org = options.organization ?? organization();
  const log: string[] = [];
  const savedCancellations: EventBillingCancellation[] = [];

  const eventRepository = {
    findOne: jest.fn().mockResolvedValue(event),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    manager: {
      transaction: jest.fn(
        async (work: (m: EntityManager) => Promise<unknown>) => {
          const eventsTx = {
            findOne: jest.fn().mockResolvedValue(event),
            save: jest.fn((e: Event) => {
              log.push(`save-event:${e.billingStatus}:${e.status}`);
              return Promise.resolve(e);
            }),
          };
          const cancellationsTx = {
            create: jest.fn((data: Partial<EventBillingCancellation>) => data),
            save: jest.fn((row: EventBillingCancellation) => {
              savedCancellations.push(row);
              log.push('save-cancellation');
              return Promise.resolve(row);
            }),
          };
          const manager = {
            query: jest.fn(() => {
              log.push('lock');
              return Promise.resolve([]);
            }),
            getRepository: jest.fn((entity: unknown) => {
              if (entity === Event) return eventsTx;
              if (entity === Order)
                return {
                  count: jest.fn().mockResolvedValue(options.realOrders ?? 0),
                };
              if (entity === EventBillingCancellation) return cancellationsTx;
              throw new Error('unexpected repository');
            }),
          } as unknown as EntityManager;
          const result = await work(manager);
          log.push('commit');
          return result;
        },
      ),
    },
  };
  const organizationRepository = {
    findOne: jest.fn().mockResolvedValue(org),
    save: jest.fn((o: Organization) => Promise.resolve(o)),
  };
  const orderRepository = {
    count: jest.fn().mockResolvedValue(options.realOrders ?? 0),
  };
  const cancellationRepository = {
    count: jest.fn().mockResolvedValue(options.ownCancellations ?? 0),
    findOne: jest.fn().mockResolvedValue(options.cancellationRow ?? null),
    save: jest.fn((row: EventBillingCancellation) => Promise.resolve(row)),
  };
  const userOrganizationRepository = {
    find: jest
      .fn()
      .mockResolvedValue([
        { user: { email: 'admin1@example.org' } },
        { user: { email: 'admin2@example.org' } },
      ]),
  };
  const stripe = {
    isConfigured: options.configured ?? true,
    ensureCustomer: jest.fn().mockResolvedValue('cus_new'),
    createAndSendInvoice: jest
      .fn()
      .mockResolvedValue(stripeInvoice({ status: 'open' })),
    sendInvoice: jest.fn().mockResolvedValue(stripeInvoice()),
    markInvoicePaidOutOfBand: jest.fn().mockResolvedValue(
      stripeInvoice({
        status: 'paid',
        amount_paid: 4000,
        status_transitions: { paid_at: 1787000000 },
      }),
    ),
    fetchInvoicePdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
  };
  const email = {
    sendAdminBillingAlert: jest.fn().mockResolvedValue(true),
    sendEventInvoicePaymentFailedEmail: jest.fn().mockResolvedValue(true),
    sendEventInvoiceClosedEmail: jest.fn().mockResolvedValue(true),
    sendEventInvoiceIssuedEmail: jest.fn().mockResolvedValue(true),
    sendAdminEventOrderedNotification: jest.fn().mockResolvedValue(true),
  };
  const settings = {
    resolveNotificationTarget: jest.fn().mockResolvedValue('ops@openeos.de'),
    resolvePlatformAdminEmail: jest.fn().mockResolvedValue('admin@openeos.de'),
  };
  const gateway = { notifyEventStatusChanged: jest.fn() };
  const audit = {
    record: jest.fn().mockResolvedValue(undefined),
    hasEntryWithDetail: jest.fn().mockResolvedValue(options.seen ?? false),
  };
  const config = {
    get: jest.fn((key: string) =>
      key === 'billing.invoiceDaysUntilDue' ? options.configDays : undefined,
    ),
  };

  const service = new StripeInvoiceService(
    eventRepository as unknown as Repository<Event>,
    organizationRepository as unknown as Repository<Organization>,
    orderRepository as unknown as Repository<Order>,
    cancellationRepository as unknown as Repository<EventBillingCancellation>,
    userOrganizationRepository as unknown as Repository<UserOrganization>,
    stripe as unknown as StripeService,
    config as unknown as ConfigService,
    email as unknown as EmailService,
    settings as unknown as PlatformSettingsService,
    gateway as unknown as GatewayService,
    audit as unknown as BillingAuditService,
  );

  return {
    service,
    event: event as Event,
    org,
    log,
    savedCancellations,
    eventRepository,
    organizationRepository,
    cancellationRepository,
    stripe,
    email,
    settings,
    gateway,
    audit,
    config,
  };
}

describe('invoice snapshot and summary', () => {
  it('mirrors number, status, due date, paid date and links', () => {
    expect(
      snapshotOf(
        stripeInvoice({
          status: 'paid',
          status_transitions: { paid_at: 1787000000 },
        }),
      ),
    ).toEqual({
      stripeInvoiceId: 'in_1',
      stripeInvoiceNumber: 'INV-0007',
      invoiceStatus: 'paid',
      invoiceDueAt: new Date(1786752000 * 1000),
      invoicePaidAt: new Date(1787000000 * 1000),
      invoiceHostedUrl: 'https://invoice.stripe.com/i/in_1',
      invoicePdfUrl: 'https://pay.stripe.com/invoice/in_1/pdf',
    });
  });

  it('derives "overdue" for open invoices past their due date', () => {
    const event = invoicedEvent();
    expect(
      invoiceSummaryOf(event, new Date('2026-08-14T12:00:00Z')),
    ).toMatchObject({
      status: 'open',
      number: 'INV-0007',
      hasPdf: true,
    });
    expect(
      invoiceSummaryOf(event, new Date('2026-08-16T12:00:00Z'))?.status,
    ).toBe('overdue');
    expect(
      invoiceSummaryOf(
        invoicedEvent({ invoiceStatus: 'paid' }),
        new Date('2026-08-16T12:00:00Z'),
      )?.status,
    ).toBe('paid');
    expect(
      invoiceSummaryOf(invoicedEvent({ stripeInvoiceId: null })),
    ).toBeNull();
  });
});

describe('StripeInvoiceService.daysUntilDue', () => {
  it('prefers the organization, then the environment, then 14', () => {
    expect(setup({ configDays: 30 }).service.daysUntilDue(organization())).toBe(
      30,
    );
    expect(
      setup({ configDays: 30 }).service.daysUntilDue(
        organization({ invoiceDaysUntilDue: 7 }),
      ),
    ).toBe(7);
    expect(setup().service.daysUntilDue(organization())).toBe(14);
    expect(
      setup({ configDays: Number.NaN }).service.daysUntilDue(organization()),
    ).toBe(14);
  });
});

describe('StripeInvoiceService.issue', () => {
  const price = {
    pricePerDay: 25,
    days: 2,
    businessDayStartHour: 6,
    price: 50,
    discountPercent: 20,
    discountReason: 'first-event' as const,
    finalPrice: 40,
  };

  it('creates the customer with address and German locale and one line per activation plus the discount', async () => {
    const { service, stripe } = setup({ configDays: 21 });
    const result = await service.issue({
      event: invoicedEvent({ stripeInvoiceId: null }),
      organization: organization(),
      price,
      billingEmail: 'kasse@example.org',
    });

    expect(stripe.ensureCustomer).toHaveBeenCalledWith({
      existingCustomerId: null,
      organizationId: ORG,
      organizationName: 'Musikverein Harmonie e.V.',
      email: 'kasse@example.org',
      address: {
        line1: 'Hauptstraße 1',
        postal_code: '12345',
        city: 'Musterstadt',
        country: 'DE',
      },
    });
    const call = (
      stripe.createAndSendInvoice.mock.calls as unknown[][]
    )[0][0] as {
      customerId: string;
      currency: string;
      daysUntilDue: number;
      footer: string;
      description: string;
      lines: { description: string; amountInCents: number }[];
      metadata: Record<string, string>;
      idempotencyKey: string;
    };
    expect(call.customerId).toBe('cus_new');
    expect(call.currency).toBe('EUR');
    expect(call.daysUntilDue).toBe(21);
    expect(call.footer).toBe(VAT_EXEMPT_NOTE);
    expect(call.footer).toContain('§ 19 UStG');
    expect(call.description).toContain('Sommerfest');
    expect(call.lines).toHaveLength(2);
    expect(call.lines[0].amountInCents).toBe(5000);
    expect(call.lines[0].description).toContain('Sommerfest');
    expect(call.lines[0].description).toContain('11.09.2026');
    expect(call.lines[0].description).toContain('12.09.2026');
    expect(call.lines[0].description).toContain('2 Veranstaltungstage');
    expect(call.lines[0].description).toMatch(/25,00\s€/);
    expect(call.lines[1]).toEqual({
      description: 'Nachlass für die erste Veranstaltung (−20 %)',
      amountInCents: -1000,
    });
    expect(call.lines.reduce((sum, line) => sum + line.amountInCents, 0)).toBe(
      4000,
    );
    expect(call.metadata).toEqual({
      eventId: EVENT_ID,
      organizationId: ORG,
      days: '2',
      kind: 'event_unlock',
    });
    expect(call.idempotencyKey).toBe(`event-invoice:${EVENT_ID}:0:40:2d`);
    expect(result).toEqual({
      customerId: 'cus_new',
      snapshot: containing({
        stripeInvoiceId: 'in_1',
        stripeInvoiceNumber: 'INV-0007',
        invoiceStatus: 'open',
        invoiceHostedUrl: 'https://invoice.stripe.com/i/in_1',
      }),
    });
  });

  it('shows an end at or before the day change on the previous day', async () => {
    const period = async (endDate: Date) => {
      const { service, stripe } = setup();
      await service.issue({
        event: invoicedEvent({
          stripeInvoiceId: null,
          startDate: new Date('2026-09-11T15:00:00.000Z'),
          endDate,
        }),
        organization: organization(),
        price,
        billingEmail: 'kasse@example.org',
      });
      return (
        (stripe.createAndSendInvoice.mock.calls as unknown[][])[0][0] as {
          lines: { description: string }[];
        }
      ).lines[0].description;
    };
    // Sa 12.09. 02:00 Berlin — noch der Veranstaltungstag Freitag.
    expect(await period(new Date('2026-09-12T00:00:00.000Z'))).toContain(
      '11.09.2026 ·',
    );
    // So 13.09. 00:30 Berlin — noch Samstag.
    expect(await period(new Date('2026-09-12T22:30:00.000Z'))).toContain(
      '11.09.2026 – 12.09.2026',
    );
    // So 13.09. 18:00 Berlin — ein dritter Tag.
    expect(await period(new Date('2026-09-13T16:00:00.000Z'))).toContain(
      '11.09.2026 – 13.09.2026',
    );
  });

  it('skips the discount line without a discount and reuses the customer', async () => {
    const { service, stripe } = setup({ ownCancellations: 2 });
    await service.issue({
      event: invoicedEvent({ stripeInvoiceId: null }),
      organization: organization({ stripeCustomerId: 'cus_old' }),
      price: {
        ...price,
        discountPercent: 0,
        discountReason: null,
        finalPrice: 50,
      },
      billingEmail: 'kasse@example.org',
    });
    expect(stripe.ensureCustomer).toHaveBeenCalledWith(
      containing({ existingCustomerId: 'cus_old' }),
    );
    const call = (
      stripe.createAndSendInvoice.mock.calls as unknown[][]
    )[0][0] as {
      lines: unknown[];
      idempotencyKey: string;
    };
    expect(call.lines).toHaveLength(1);
    // Nach zwei Stornierungen: ein neuer Schluessel, keine stornierte Rechnung zurueck.
    expect(call.idempotencyKey).toBe(`event-invoice:${EVENT_ID}:2:50:2d`);
  });
});

describe('EventBillingService.orderInvoice with Stripe Invoicing', () => {
  function billingSetup(available: boolean) {
    const event = invoicedEvent({
      billingStatus: 'none',
      stripeInvoiceId: null,
      stripeInvoiceNumber: null,
      invoiceStatus: null,
      invoicedAt: null,
      invoiceNote: null,
      priceCharged: null,
      billedDays: null,
      paidAt: null,
    });
    const org = organization({ billingAddress: null, billingEmail: null });
    const eventRepository = {
      findOne: jest.fn().mockResolvedValue(event),
      save: jest.fn((e: Event) => Promise.resolve(e)),
      createQueryBuilder: jest.fn(() => ({
        withDeleted: () => ({
          where: () => ({
            andWhere: () => ({
              andWhere: () => ({ getCount: () => Promise.resolve(0) }),
            }),
          }),
        }),
      })),
    };
    const organizationRepository = {
      findOne: jest.fn().mockResolvedValue(org),
      save: jest.fn((o: Organization) => Promise.resolve(o)),
    };
    const email = {
      sendEventInvoiceIssuedEmail: jest.fn().mockResolvedValue(true),
      sendAdminEventOrderedNotification: jest.fn().mockResolvedValue(true),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const issue = jest.fn().mockResolvedValue({
      customerId: 'cus_new',
      snapshot: snapshotOf(stripeInvoice()),
    });
    const service = new EventBillingService(
      eventRepository as unknown as Repository<Event>,
      organizationRepository as unknown as Repository<Organization>,
      { checkRole: jest.fn() } as unknown as OrganizationsService,
      email as unknown as EmailService,
      {
        resolveNotificationTarget: jest
          .fn()
          .mockResolvedValue('ops@openeos.de'),
      } as unknown as PlatformSettingsService,
      { isConfigured: available } as unknown as StripeService,
      {
        get: (key: string, fallback?: unknown) =>
          key === 'billing.firstEventDiscountPercent' ? 20 : fallback,
      } as unknown as ConfigService,
      {} as EventUnlockCancellationService,
      audit as unknown as BillingAuditService,
      {
        isAvailable: available,
        daysUntilDue: () => 14,
        issue,
      } as unknown as StripeInvoiceService,
    );
    return { service, event, org, issue, email, audit, organizationRepository };
  }
  const dto = {
    billingName: 'Musikverein Harmonie e.V.',
    billingEmail: 'kasse@example.org',
    billingAddress: {
      street: 'Hauptstraße 1',
      zip: '12345',
      city: 'Musterstadt',
    },
  };
  const user = { id: 'user-1', email: 'u@example.org' } as User;

  it('issues the Stripe invoice before unlocking and mirrors it on the event', async () => {
    const { service, issue, email, audit, org, organizationRepository } =
      billingSetup(true);
    const event = await service.orderInvoice(ORG, EVENT_ID, dto, user);

    expect(issue).toHaveBeenCalledWith(
      containing({
        billingEmail: 'kasse@example.org',
        price: containing({ finalPrice: 40, days: 2, discountPercent: 20 }),
      }),
    );
    expect(org.stripeCustomerId).toBe('cus_new');
    expect(organizationRepository.save).toHaveBeenCalledTimes(2);
    expect(event).toMatchObject({
      billingStatus: 'invoice',
      priceCharged: 40,
      billedDays: 2,
      stripeInvoiceId: 'in_1',
      stripeInvoiceNumber: 'INV-0007',
      invoiceStatus: 'open',
      invoiceHostedUrl: 'https://invoice.stripe.com/i/in_1',
      invoiceNote: 'Stripe-Rechnung INV-0007',
    });
    expect(event.invoicedAt).toBeInstanceOf(Date);
    expect(event.paidAt).toBeInstanceOf(Date);
    expect(audit.record).toHaveBeenCalledWith(
      containing({
        action: AdminAction.EVENT_INVOICE_ISSUED,
        details: containing({ invoiceId: 'in_1', amount: 40, days: 2 }),
      }),
    );
    // Unsere Bestaetigung verlinkt Stripes Rechnungsseite statt ein eigenes PDF.
    expect(email.sendEventInvoiceIssuedEmail).toHaveBeenCalledWith(
      containing({
        to: 'kasse@example.org',
        hostedUrl: 'https://invoice.stripe.com/i/in_1',
        invoiceNumber: 'INV-0007',
        amount: 40,
      }),
    );
    expect(email.sendAdminEventOrderedNotification).toHaveBeenCalledWith(
      containing({
        paymentMethod: 'invoice',
        invoice: { number: 'INV-0007', dueAt: new Date(1786752000 * 1000) },
      }),
    );
  });

  it('falls back to the manual invoice without Stripe', async () => {
    const { service, issue, email } = billingSetup(false);
    const event = await service.orderInvoice(ORG, EVENT_ID, dto, user);
    expect(issue).not.toHaveBeenCalled();
    expect(event).toMatchObject({
      billingStatus: 'invoice',
      stripeInvoiceId: null,
      invoicedAt: null,
    });
    expect(email.sendEventInvoiceIssuedEmail).not.toHaveBeenCalled();
    expect(email.sendAdminEventOrderedNotification).toHaveBeenCalledWith(
      containing({ paymentMethod: 'invoice', invoice: null }),
    );
  });

  it('leaves the event untouched when Stripe refuses the invoice', async () => {
    const { service, issue, event } = billingSetup(true);
    issue.mockRejectedValue(new Error('Stripe down'));
    await expect(
      service.orderInvoice(ORG, EVENT_ID, dto, user),
    ).rejects.toThrow('Stripe down');
    expect(event.billingStatus).toBe('none');
  });
});

describe('StripeInvoiceService webhooks', () => {
  it('invoice.finalized / invoice.sent only mirror the invoice', async () => {
    const { service, eventRepository, audit, email } = setup();
    await service.handleInvoiceEvent(
      'invoice.finalized',
      stripeInvoice(),
      'evt_1',
    );
    await service.handleInvoiceEvent('invoice.sent', stripeInvoice(), 'evt_2');
    expect(eventRepository.update).toHaveBeenCalledWith(
      { id: EVENT_ID, stripeInvoiceId: 'in_1' },
      containing({ invoiceStatus: 'open', stripeInvoiceNumber: 'INV-0007' }),
    );
    expect(audit.record).not.toHaveBeenCalled();
    expect(email.sendAdminBillingAlert).not.toHaveBeenCalled();
  });

  it('ignores invoices that belong to no event', async () => {
    const { service, eventRepository, audit } = setup({ event: null });
    await service.handleInvoiceEvent(
      'invoice.paid',
      stripeInvoice({ metadata: {} }),
      'evt_1',
    );
    expect(eventRepository.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('invoice.paid: mirrors paid status, audits once, tells the operator', async () => {
    const { service, event, eventRepository, audit, email, settings } = setup();
    const paid = stripeInvoice({
      status: 'paid',
      amount_paid: 4000,
      status_transitions: { paid_at: 1787000000 },
    });
    await service.handleInvoiceEvent('invoice.paid', paid, 'evt_p1');

    expect(eventRepository.update).toHaveBeenCalledWith(
      { id: EVENT_ID, stripeInvoiceId: 'in_1' },
      containing({
        invoiceStatus: 'paid',
        invoicePaidAt: new Date(1787000000 * 1000),
      }),
    );
    // Die Freischaltung gilt weiter als "auf Rechnung" — bezahlt steht am Spiegel.
    expect(event?.billingStatus).toBe('invoice');
    expect(event?.invoiceStatus).toBe('paid');
    expect(audit.record).toHaveBeenCalledWith(
      containing({
        action: AdminAction.EVENT_INVOICE_PAID,
        organizationId: ORG,
        eventId: EVENT_ID,
        details: containing({
          stripeEventId: 'evt_p1',
          invoiceId: 'in_1',
          amount: 40,
          currency: 'EUR',
          orphaned: false,
        }),
      }),
    );
    expect(settings.resolveNotificationTarget).toHaveBeenCalledWith(
      'eventOrdered',
    );
    const mail = (
      email.sendAdminBillingAlert.mock.calls as unknown[][]
    )[0][0] as {
      subject: string;
      rows: [string, string][];
      todo: unknown;
    };
    expect(mail.subject).toBe('Rechnung bezahlt');
    expect(Object.fromEntries(mail.rows)).toMatchObject({
      Organisation: 'Musikverein',
      Rechnung: 'INV-0007',
    });
    expect(mail.todo).toBeNull();
  });

  it('invoice.paid delivered twice sends one mail', async () => {
    const { service, audit, email } = setup({ seen: true });
    await service.handleInvoiceEvent(
      'invoice.paid',
      stripeInvoice({ status: 'paid', amount_paid: 4000 }),
      'evt_p1',
    );
    expect(audit.record).not.toHaveBeenCalled();
    expect(email.sendAdminBillingAlert).not.toHaveBeenCalled();
  });

  it('invoice.paid for a cancelled activation: alert with a refund to-do', async () => {
    const { service, email, audit } = setup({
      event: invoicedEvent({
        billingStatus: 'none',
        stripeInvoiceId: null,
        invoiceStatus: null,
      }),
    });
    await service.handleInvoiceEvent(
      'invoice.paid',
      stripeInvoice({ status: 'paid', amount_paid: 4000 }),
      'evt_p2',
    );
    expect(audit.record).toHaveBeenCalledWith(
      containing({ details: containing({ orphaned: true }) }),
    );
    const mail = (
      email.sendAdminBillingAlert.mock.calls as unknown[][]
    )[0][0] as {
      to: string;
      subject: string;
      todo: { title: string } | null;
    };
    expect(mail.to).toBe('admin@openeos.de');
    expect(mail.subject).toContain('aufgehobenen Rechnung');
    expect(mail.todo?.title).toContain('erstatten');
  });

  it('invoice.payment_failed: invoice stays open, the organization is told how to retry', async () => {
    const { service, event, audit, email } = setup();
    await service.handleInvoiceEvent(
      'invoice.payment_failed',
      stripeInvoice({ attempt_count: 1 }),
      'evt_f1',
    );
    expect(event.billingStatus).toBe('invoice');
    expect(event.invoiceStatus).toBe('open');
    expect(audit.record).toHaveBeenCalledWith(
      containing({
        action: AdminAction.EVENT_INVOICE_PAYMENT_FAILED,
        details: containing({ stripeEventId: 'evt_f1', invoiceId: 'in_1' }),
      }),
    );
    expect(email.sendEventInvoicePaymentFailedEmail).toHaveBeenCalledTimes(1);
    expect(email.sendEventInvoicePaymentFailedEmail).toHaveBeenCalledWith(
      containing({
        to: 'kasse@example.org',
        invoiceNumber: 'INV-0007',
        amount: 40,
        hostedUrl: 'https://invoice.stripe.com/i/in_1',
      }),
    );
  });

  it('invoice.payment_failed delivered twice mails once', async () => {
    const { service, email } = setup({ seen: true });
    await service.handleInvoiceEvent(
      'invoice.payment_failed',
      stripeInvoice(),
      'evt_f1',
    );
    expect(email.sendEventInvoicePaymentFailedEmail).not.toHaveBeenCalled();
  });

  it('invoice.voided without orders: activation released like an expired checkout', async () => {
    const { service, event, savedCancellations, log, audit, email, gateway } =
      setup();
    await service.handleInvoiceEvent(
      'invoice.voided',
      stripeInvoice({ status: 'void' }),
      'evt_v1',
    );

    expect(log).toEqual([
      'lock',
      'save-cancellation',
      'save-event:none:test',
      'commit',
    ]);
    expect(savedCancellations[0]).toMatchObject({
      eventId: EVENT_ID,
      initiatedBy: 'platform',
      kind: 'cancellation',
      previousBillingStatus: 'invoice',
      amount: 40,
      stripeInvoiceId: 'in_1',
      invoiceVoided: true,
      refundVia: 'void',
      manualCreditNoteRequired: false,
    });
    expect(event).toMatchObject({
      billingStatus: 'none',
      status: EventStatus.TEST,
      stripeInvoiceId: null,
      invoiceStatus: null,
      priceCharged: null,
    });
    expect(audit.record).toHaveBeenCalledWith(
      containing({
        action: AdminAction.EVENT_INVOICE_VOIDED,
        details: containing({
          stripeEventId: 'evt_v1',
          invoiceId: 'in_1',
          released: true,
          realOrders: 0,
        }),
      }),
    );
    expect(gateway.notifyEventStatusChanged).toHaveBeenCalledWith(
      ORG,
      containing({ eventId: EVENT_ID, status: EventStatus.TEST }),
    );
    expect(email.sendEventInvoiceClosedEmail).toHaveBeenCalledWith(
      containing({
        to: 'kasse@example.org',
        reason: 'void',
        activationReleased: true,
        invoiceNumber: 'INV-0007',
      }),
    );
    expect(email.sendAdminBillingAlert).not.toHaveBeenCalled();
  });

  it('invoice.marked_uncollectible with real orders: unlock kept, operator decides', async () => {
    const { service, event, savedCancellations, audit, email } = setup({
      realOrders: 12,
    });
    await service.handleInvoiceEvent(
      'invoice.marked_uncollectible',
      stripeInvoice({ status: 'uncollectible' }),
      'evt_u1',
    );
    expect(savedCancellations).toHaveLength(0);
    expect(event.billingStatus).toBe('invoice');
    expect(event.status).toBe(EventStatus.ACTIVE);
    expect(event.invoiceStatus).toBe('uncollectible');
    expect(audit.record).toHaveBeenCalledWith(
      containing({
        action: AdminAction.EVENT_INVOICE_UNCOLLECTIBLE,
        details: containing({ released: false, realOrders: 12 }),
      }),
    );
    expect(email.sendEventInvoiceClosedEmail).toHaveBeenCalledWith(
      containing({ reason: 'uncollectible', activationReleased: false }),
    );
    const mail = (
      email.sendAdminBillingAlert.mock.calls as unknown[][]
    )[0][0] as {
      subject: string;
      rows: [string, string][];
    };
    expect(mail.subject).toContain('uneinbringlich');
    expect(Object.fromEntries(mail.rows)['Echte Bestellungen']).toBe('12');
  });

  it('invoice.voided caused by our own cancellation changes nothing more', async () => {
    const { service, savedCancellations, audit, email } = setup({
      ownCancellations: 1,
    });
    await service.handleInvoiceEvent(
      'invoice.voided',
      stripeInvoice({ status: 'void' }),
      'evt_v2',
    );
    expect(savedCancellations).toHaveLength(0);
    expect(audit.record).not.toHaveBeenCalled();
    expect(email.sendEventInvoiceClosedEmail).not.toHaveBeenCalled();
  });

  it('invoice.voided for an older invoice of the event is ignored', async () => {
    const { service, savedCancellations, eventRepository } = setup({
      event: invoicedEvent({ stripeInvoiceId: 'in_newer' }),
    });
    await service.handleInvoiceEvent(
      'invoice.voided',
      stripeInvoice({ status: 'void' }),
      'evt_v3',
    );
    expect(eventRepository.update).not.toHaveBeenCalled();
    expect(savedCancellations).toHaveLength(0);
  });

  it('invoice.voided without billing e-mail writes to all admins', async () => {
    const { service, email } = setup({
      organization: organization({ billingEmail: null }),
    });
    await service.handleInvoiceEvent(
      'invoice.voided',
      stripeInvoice({ status: 'void' }),
      'evt_v4',
    );
    expect(
      (email.sendEventInvoiceClosedEmail.mock.calls as { to: string }[][]).map(
        (c) => c[0].to,
      ),
    ).toEqual(['admin1@example.org', 'admin2@example.org']);
  });

  it('credit_note.created from our cancellation: fills in the number and audits', async () => {
    const row = {
      id: 'cancel-1',
      eventId: EVENT_ID,
      organizationId: ORG,
      stripeCreditNoteId: 'cn_1',
      creditNoteNumber: null,
    } as unknown as EventBillingCancellation;
    const { service, cancellationRepository, audit } = setup({
      cancellationRow: row,
    });
    const note = {
      id: 'cn_1',
      number: 'INV-0007-CN-01',
      invoice: 'in_1',
      total: 4000,
      currency: 'eur',
      status: 'issued',
      reason: 'order_change',
      memo: 'Stornierung der Freischaltung · Sommerfest',
    } as unknown as Stripe.CreditNote;
    await service.handleCreditNoteEvent('credit_note.created', note, 'evt_c1');

    expect(cancellationRepository.save).toHaveBeenCalledWith(
      containing({ id: 'cancel-1', creditNoteNumber: 'INV-0007-CN-01' }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      containing({
        action: AdminAction.EVENT_INVOICE_CREDIT_NOTE,
        organizationId: ORG,
        eventId: EVENT_ID,
        details: containing({
          creditNote: 'cn_1',
          number: 'INV-0007-CN-01',
          invoiceId: 'in_1',
          amount: 40,
          origin: 'openeos',
          cancellationId: 'cancel-1',
        }),
      }),
    );
  });

  it('credit_note.voided from the dashboard: audited against the event of the invoice', async () => {
    const { service, audit } = setup();
    const note = {
      id: 'cn_9',
      number: 'INV-0007-CN-02',
      invoice: { id: 'in_1' },
      total: 1000,
      currency: 'eur',
      status: 'void',
    } as unknown as Stripe.CreditNote;
    await service.handleCreditNoteEvent('credit_note.voided', note, 'evt_c2');
    expect(audit.record).toHaveBeenCalledWith(
      containing({
        eventId: EVENT_ID,
        details: containing({
          creditNoteId: 'cn_9:credit_note.voided',
          status: 'void',
          origin: 'stripe',
        }),
      }),
    );
  });
});

describe('StripeInvoiceService admin actions', () => {
  const actor = { userId: 'admin-1', ipAddress: '10.0.0.1' };

  it('resend: only open invoices, audited', async () => {
    const { service, stripe, audit } = setup();
    await service.resend(EVENT_ID, actor);
    expect(stripe.sendInvoice).toHaveBeenCalledWith('in_1');
    expect(audit.record).toHaveBeenCalledWith(
      containing({ action: AdminAction.EVENT_INVOICE_RESENT, actor }),
    );
    const paid = setup({ event: invoicedEvent({ invoiceStatus: 'paid' }) });
    await expect(paid.service.resend(EVENT_ID, actor)).rejects.toMatchObject({
      response: { reason: 'EVENT_INVOICE_NOT_OPEN' },
    });
    expect(paid.stripe.sendInvoice).not.toHaveBeenCalled();
  });

  it('mark paid: pays out of band and mirrors the paid status right away', async () => {
    const { service, stripe, event, audit } = setup();
    await service.markPaid(EVENT_ID, actor);
    expect(stripe.markInvoicePaidOutOfBand).toHaveBeenCalledWith('in_1');
    expect(event?.invoiceStatus).toBe('paid');
    expect(event?.invoicePaidAt).toEqual(new Date(1787000000 * 1000));
    expect(audit.record).toHaveBeenCalledWith(
      containing({
        action: AdminAction.EVENT_INVOICE_MARKED_PAID,
        details: containing({ amount: 40 }),
      }),
    );
  });

  it('refuses events without a Stripe invoice', async () => {
    const { service } = setup({
      event: invoicedEvent({ stripeInvoiceId: null }),
    });
    await expect(service.resend(EVENT_ID, actor)).rejects.toMatchObject({
      response: { reason: 'EVENT_NO_STRIPE_INVOICE' },
    });
    await expect(service.invoicePdf(EVENT_ID)).rejects.toMatchObject({
      response: { reason: 'EVENT_NO_STRIPE_INVOICE' },
    });
  });

  it("pdf: fetches Stripe's file under the invoice number", async () => {
    const { service, stripe } = setup();
    await expect(service.invoicePdf(EVENT_ID)).resolves.toEqual({
      filename: 'INV-0007.pdf',
      content: Buffer.from('%PDF'),
    });
    expect(stripe.fetchInvoicePdf).toHaveBeenCalledWith(
      'https://pay.stripe.com/invoice/in_1/pdf',
    );
  });
});
