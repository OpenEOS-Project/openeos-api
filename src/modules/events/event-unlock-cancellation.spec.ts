import { EntityManager, Repository } from 'typeorm';
import type Stripe from 'stripe';
import { ConfigService } from '@nestjs/config';

import {
  Event,
  EventStatus,
  EventBillingStatus,
  EVENT_PAID_BILLING_STATUSES,
} from '../../database/entities/event.entity';
import { Organization } from '../../database/entities/organization.entity';
import { Order } from '../../database/entities/order.entity';
import { EventBillingCancellation } from '../../database/entities/event-billing-cancellation.entity';
import { User } from '../../database/entities';
import { OrganizationsService } from '../organizations/organizations.service';
import { StripeService } from '../stripe/stripe.service';
import { EmailService } from '../email/email.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { GatewayService } from '../gateway/gateway.service';
import { EventBillingService } from './event-billing.service';
import {
  EventUnlockCancellationService,
  cancellationDeadline,
} from './event-unlock-cancellation.service';

const ORG = '00000000-0000-4000-8000-000000000001';
const EVENT_ID = '00000000-0000-4000-8000-0000000000e1';
const BERLIN = 'Europe/Berlin';

const admin = { id: 'user-1', email: 'admin@example.org' } as User;

function organization(overrides: Partial<Organization> = {}): Organization {
  return {
    id: ORG,
    name: 'Musikverein',
    billingEmail: 'kasse@example.org',
    billingAddress: null,
    billingMode: 'prepaid',
    eventPriceOverride: null,
    discountPercent: null,
    discountValidUntil: null,
    settings: { timezone: BERLIN, currency: 'EUR' },
    ...overrides,
  } as unknown as Organization;
}

function paidEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: EVENT_ID,
    organizationId: ORG,
    name: 'Sommerfest',
    // Freitag, 11.09.2026, 17:00 in Berlin (Sommerzeit)
    startDate: new Date('2026-09-11T15:00:00.000Z'),
    endDate: new Date('2026-09-12T22:00:00.000Z'),
    unlockedStartDate: new Date('2026-09-11T15:00:00.000Z'),
    status: EventStatus.ACTIVE,
    billingStatus: 'paid',
    paidAt: new Date('2026-08-01T10:00:00.000Z'),
    priceCharged: 40,
    billedDays: 2,
    stripeCheckoutSessionId: 'cs_paid',
    invoicedAt: null,
    invoicedBy: null,
    invoiceNote: null,
    ...overrides,
  } as unknown as Event;
}

/** 10 Tage vor Beginn — innerhalb der Frist. */
const IN_TIME = new Date('2026-09-01T10:00:00.000Z');

describe('cancellationDeadline', () => {
  it('is the same wall-clock time seven calendar days earlier', () => {
    const deadline = cancellationDeadline(
      { startDate: new Date('2026-09-11T15:00:00.000Z') },
      BERLIN,
    );
    // Freitag, 04.09.2026, 17:00 Sommerzeit
    expect(deadline?.toISOString()).toBe('2026-09-04T15:00:00.000Z');
  });

  it('keeps 17:00 across the end of summer time (not 7 x 24 h)', () => {
    // Beginn Fr 30.10.2026 17:00 MEZ; Zeitumstellung am So 25.10.
    const deadline = cancellationDeadline(
      { startDate: new Date('2026-10-30T16:00:00.000Z') },
      BERLIN,
    );
    // Fr 23.10.2026 17:00 MESZ = 15:00 UTC. 7 x 24 h ergaebe 16:00 UTC (18 Uhr).
    expect(deadline?.toISOString()).toBe('2026-10-23T15:00:00.000Z');
  });

  it('keeps 17:00 across the start of summer time', () => {
    // Beginn Fr 03.04.2026 17:00 MESZ; Zeitumstellung am So 29.03.
    const deadline = cancellationDeadline(
      { startDate: new Date('2026-04-03T15:00:00.000Z') },
      BERLIN,
    );
    // Fr 27.03.2026 17:00 MEZ = 16:00 UTC
    expect(deadline?.toISOString()).toBe('2026-03-27T16:00:00.000Z');
  });

  it('calculates in the organization time zone', () => {
    // Beginn Sa 07.11.2026 10:00 in New York (EST, UTC-5); DST endet dort am 01.11.
    const deadline = cancellationDeadline(
      { startDate: new Date('2026-11-07T15:00:00.000Z') },
      'America/New_York',
    );
    // Sa 31.10.2026 10:00 EDT = 14:00 UTC
    expect(deadline?.toISOString()).toBe('2026-10-31T14:00:00.000Z');
  });

  it('uses the start at unlock when the event was postponed afterwards', () => {
    const deadline = cancellationDeadline(
      {
        startDate: new Date('2026-12-11T16:00:00.000Z'),
        unlockedStartDate: new Date('2026-09-11T15:00:00.000Z'),
      },
      BERLIN,
    );
    expect(deadline?.toISOString()).toBe('2026-09-04T15:00:00.000Z');
  });

  it('follows an event that was brought forward', () => {
    const deadline = cancellationDeadline(
      {
        startDate: new Date('2026-09-05T15:00:00.000Z'),
        unlockedStartDate: new Date('2026-09-11T15:00:00.000Z'),
      },
      BERLIN,
    );
    expect(deadline?.toISOString()).toBe('2026-08-29T15:00:00.000Z');
  });

  it('has no deadline without a start', () => {
    expect(
      cancellationDeadline(
        { startDate: null, unlockedStartDate: null },
        BERLIN,
      ),
    ).toBeNull();
  });
});

describe('EventUnlockCancellationService', () => {
  function setup(
    options: {
      event?: Event;
      organization?: Organization;
      realOrders?: number;
      previousCancellation?: EventBillingCancellation | null;
      stripeConfigured?: boolean;
      session?: Partial<Stripe.Checkout.Session>;
      creditNoteError?: Error;
      refundError?: Error;
      refundStatus?: string;
    } = {},
  ) {
    const event = options.event ?? paidEvent();
    const org = options.organization ?? organization();
    const log: string[] = [];
    const saved: EventBillingCancellation[] = [];

    const eventTx = {
      findOne: jest.fn().mockResolvedValue(event),
      save: jest.fn((e: Event) => {
        log.push(`save-event:${e.billingStatus}:${e.status}`);
        return Promise.resolve(e);
      }),
    };
    const orgTx = { findOne: jest.fn().mockResolvedValue(org) };
    const orderTx = {
      count: jest.fn().mockResolvedValue(options.realOrders ?? 0),
    };
    const cancellationTx = {
      findOne: jest
        .fn()
        .mockResolvedValue(options.previousCancellation ?? null),
      create: jest.fn((data: Partial<EventBillingCancellation>) => ({
        ...data,
      })),
      save: jest.fn((record: EventBillingCancellation) => {
        const row = {
          ...record,
          id: 'cancel-1',
          createdAt: new Date('2026-09-01T10:00:00.000Z'),
        } as EventBillingCancellation;
        saved.push(row);
        log.push('save-cancellation');
        return Promise.resolve(row);
      }),
    };
    const manager = {
      query: jest.fn((sql: string) => {
        if (sql.includes('FOR UPDATE')) log.push('lock');
        return Promise.resolve([]);
      }),
      getRepository: jest.fn((entity: unknown) => {
        if (entity === Event) return eventTx;
        if (entity === Organization) return orgTx;
        if (entity === Order) return orderTx;
        if (entity === EventBillingCancellation) return cancellationTx;
        throw new Error('unexpected repository');
      }),
    } as unknown as EntityManager;

    let committed = false;
    const eventRepository = {
      manager: {
        transaction: jest.fn(
          async (work: (m: EntityManager) => Promise<unknown>) => {
            const result = await work(manager);
            committed = true;
            log.push('commit');
            return result;
          },
        ),
      },
      findOne: jest.fn().mockResolvedValue(event),
    } as unknown as Repository<Event>;

    const orderRepository = {
      count: jest.fn().mockResolvedValue(options.realOrders ?? 0),
    } as unknown as Repository<Order>;
    const cancellationRepository = {
      findOne: jest.fn(),
      save: jest.fn((r: EventBillingCancellation) => Promise.resolve(r)),
      count: jest.fn().mockResolvedValue(0),
    };

    const session = {
      id: 'cs_paid',
      payment_intent: 'pi_1',
      invoice: {
        id: 'in_1',
        status: 'paid',
        amount_paid: 4000,
      } as Stripe.Invoice,
      ...options.session,
    } as Stripe.Checkout.Session;

    const stripe = {
      isConfigured: options.stripeConfigured ?? true,
      getCheckoutSessionForRefund: jest.fn().mockResolvedValue(session),
      createCreditNoteWithRefund: jest.fn(() => {
        log.push('stripe:credit-note');
        return options.creditNoteError
          ? Promise.reject(options.creditNoteError)
          : Promise.resolve({
              id: 'cn_1',
              number: 'ABCD-0001-CN-01',
              refunds: [{ refund: 're_1', amount_refunded: 4000 }],
            });
      }),
      refundIdOfCreditNote: jest.fn(
        (note: { refunds: { refund: string }[] }) =>
          note.refunds?.[0]?.refund ?? null,
      ),
      retrieveRefund: jest.fn().mockResolvedValue({
        id: 're_1',
        status: options.refundStatus ?? 'pending',
      }),
      createRefund: jest.fn(() => {
        log.push('stripe:refund');
        return options.refundError
          ? Promise.reject(options.refundError)
          : Promise.resolve({ id: 're_2', status: 'succeeded' });
      }),
    };

    const email = {
      sendEventUnlockCancelledEmail: jest.fn().mockResolvedValue(true),
      sendAdminEventUnlockCancelledNotification: jest
        .fn()
        .mockResolvedValue(true),
      sendAdminEventRefundFailedNotification: jest.fn().mockResolvedValue(true),
    };
    const platformSettings = {
      resolveNotificationTarget: jest.fn().mockResolvedValue('ops@openeos.de'),
    };
    const gateway = { notifyEventStatusChanged: jest.fn() };
    const organizations = { checkRole: jest.fn().mockResolvedValue({}) };

    const service = new EventUnlockCancellationService(
      eventRepository,
      orderRepository,
      cancellationRepository as unknown as Repository<EventBillingCancellation>,
      organizations as unknown as OrganizationsService,
      stripe as unknown as StripeService,
      email as unknown as EmailService,
      platformSettings as unknown as PlatformSettingsService,
      gateway as unknown as GatewayService,
    );

    return {
      service,
      event,
      log,
      saved,
      stripe,
      email,
      gateway,
      organizations,
      orderTx,
      eventTx,
      cancellationRepository,
      isCommitted: () => committed,
    };
  }

  describe('deadline boundary', () => {
    // Frist: Fr 04.09.2026 17:00 Berlin = 15:00 UTC
    it('allows a cancellation one minute before the deadline', async () => {
      const { service, saved } = setup();
      await service.cancelForOrganization(
        ORG,
        EVENT_ID,
        admin,
        new Date('2026-09-04T14:59:00.000Z'),
      );
      expect(saved).toHaveLength(1);
    });

    it('refuses at the deadline itself', async () => {
      const { service, stripe, isCommitted } = setup();
      await expect(
        service.cancelForOrganization(
          ORG,
          EVENT_ID,
          admin,
          new Date('2026-09-04T15:00:00.000Z'),
        ),
      ).rejects.toMatchObject({
        response: {
          reason: 'EVENT_CANCELLATION_DEADLINE_PASSED',
          params: { deadline: '2026-09-04T15:00:00.000Z' },
        },
      });
      expect(stripe.createCreditNoteWithRefund).not.toHaveBeenCalled();
      expect(isCommitted()).toBe(false);
    });

    it('lets the platform cancel after the deadline', async () => {
      const { service, saved } = setup();
      await service.cancelForPlatform(
        EVENT_ID,
        admin,
        new Date('2026-09-10T10:00:00.000Z'),
      );
      expect(saved[0]).toMatchObject({
        initiatedBy: 'platform',
        deadline: null,
      });
    });
  });

  it('only admins may cancel', async () => {
    const { service, organizations } = setup();
    await service.cancelForOrganization(ORG, EVENT_ID, admin, IN_TIME);
    expect(organizations.checkRole).toHaveBeenCalledWith(ORG, admin, 'admin');
  });

  it('refuses when real orders exist and moves no money', async () => {
    const { service, stripe, orderTx, isCommitted } = setup({ realOrders: 3 });
    await expect(
      service.cancelForOrganization(ORG, EVENT_ID, admin, IN_TIME),
    ).rejects.toMatchObject({
      response: { reason: 'EVENT_HAS_ORDERS', params: { orders: 3 } },
    });
    // Testbestellungen zaehlen nicht mit.
    expect(orderTx.count).toHaveBeenCalledWith({
      where: { eventId: EVENT_ID, isTest: false },
    });
    expect(stripe.createCreditNoteWithRefund).not.toHaveBeenCalled();
    expect(stripe.createRefund).not.toHaveBeenCalled();
    expect(isCommitted()).toBe(false);
  });

  it('refunds via a credit note when the checkout produced an invoice', async () => {
    const { service, event, log, saved, stripe, email, gateway } = setup();

    const result = await service.cancelForOrganization(
      ORG,
      EVENT_ID,
      admin,
      IN_TIME,
    );

    // Erst sperren, dann Stripe, dann speichern, dann Commit.
    expect(log).toEqual([
      'lock',
      'stripe:credit-note',
      'save-event:none:test',
      'save-cancellation',
      'commit',
    ]);
    expect(stripe.createCreditNoteWithRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId: 'in_1',
        amountInCents: 4000,
        idempotencyKey: `event-unlock-cancel:${EVENT_ID}:cs_paid:credit-note`,
      }),
    );
    expect(stripe.createRefund).not.toHaveBeenCalled();
    expect(saved[0]).toMatchObject({
      previousBillingStatus: 'paid',
      amount: 40,
      currency: 'EUR',
      cancelledBy: admin.id,
      initiatedBy: 'organization',
      stripeCheckoutSessionId: 'cs_paid',
      stripePaymentIntentId: 'pi_1',
      stripeInvoiceId: 'in_1',
      stripeCreditNoteId: 'cn_1',
      creditNoteNumber: 'ABCD-0001-CN-01',
      stripeRefundId: 're_1',
      refundStatus: 'pending',
      billedDays: 2,
    });
    expect(result.id).toBe('cancel-1');

    // Freischaltung weg, aktive Veranstaltung im Testmodus.
    expect(event).toMatchObject({
      billingStatus: 'none',
      status: EventStatus.TEST,
      paidAt: null,
      priceCharged: null,
      billedDays: null,
      stripeCheckoutSessionId: null,
      unlockedStartDate: null,
    });
    expect(gateway.notifyEventStatusChanged).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ eventId: EVENT_ID, status: EventStatus.TEST }),
    );
    expect(email.sendEventUnlockCancelledEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'kasse@example.org',
        via: 'stripe',
        amount: 40,
        creditNoteNumber: 'ABCD-0001-CN-01',
      }),
    );
    expect(
      email.sendAdminEventUnlockCancelledNotification,
    ).toHaveBeenCalledWith(expect.objectContaining({ to: 'ops@openeos.de' }));
  });

  it('refunds the payment directly when there is no invoice', async () => {
    const { service, stripe, saved } = setup({
      session: { invoice: null },
      event: paidEvent({ status: EventStatus.INACTIVE }),
    });
    await service.cancelForOrganization(ORG, EVENT_ID, admin, IN_TIME);
    expect(stripe.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: 'pi_1',
        idempotencyKey: `event-unlock-cancel:${EVENT_ID}:cs_paid:refund`,
      }),
    );
    expect(saved[0]).toMatchObject({
      stripeRefundId: 're_2',
      refundStatus: 'succeeded',
      stripeCreditNoteId: null,
    });
  });

  it('keeps an inactive event inactive and does not notify devices', async () => {
    const { service, event, gateway } = setup({
      session: { invoice: null },
      event: paidEvent({ status: EventStatus.INACTIVE }),
    });
    await service.cancelForOrganization(ORG, EVENT_ID, admin, IN_TIME);
    expect(event.status).toBe(EventStatus.INACTIVE);
    expect(gateway.notifyEventStatusChanged).not.toHaveBeenCalled();
  });

  it('changes nothing when Stripe refuses the refund', async () => {
    const { service, event, eventTx, saved, email, isCommitted } = setup({
      creditNoteError: new Error('charge_already_refunded'),
    });
    await expect(
      service.cancelForOrganization(ORG, EVENT_ID, admin, IN_TIME),
    ).rejects.toMatchObject({
      status: 502,
      response: { code: 'STRIPE_API_ERROR', reason: 'REFUND_FAILED' },
    });
    expect(eventTx.save).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
    expect(isCommitted()).toBe(false);
    expect(event.billingStatus).toBe('paid');
    expect(email.sendEventUnlockCancelledEmail).not.toHaveBeenCalled();
  });

  it('refuses a Stripe refund when Stripe is not configured', async () => {
    const { service, isCommitted } = setup({ stripeConfigured: false });
    await expect(
      service.cancelForOrganization(ORG, EVENT_ID, admin, IN_TIME),
    ).rejects.toMatchObject({ response: { reason: 'REFUND_FAILED' } });
    expect(isCommitted()).toBe(false);
  });

  describe('invoice orders', () => {
    it('moves no money and flags a manual credit note once invoiced', async () => {
      const invoicedAt = new Date('2026-08-05T10:00:00.000Z');
      const { service, stripe, saved, event, email } = setup({
        event: paidEvent({
          billingStatus: 'invoice',
          stripeCheckoutSessionId: null,
          paidAt: null,
          invoicedAt,
          invoicedBy: 'platform-admin',
          invoiceNote: 'RE-2026-014',
        }),
      });
      await service.cancelForOrganization(ORG, EVENT_ID, admin, IN_TIME);

      expect(stripe.getCheckoutSessionForRefund).not.toHaveBeenCalled();
      expect(saved[0]).toMatchObject({
        previousBillingStatus: 'invoice',
        amount: 40,
        manualCreditNoteRequired: true,
        invoicedAt,
        invoiceNote: 'RE-2026-014',
      });
      expect(saved[0].stripeRefundId).toBeUndefined();
      expect(event).toMatchObject({
        billingStatus: 'none',
        invoicedAt: null,
        invoicedBy: null,
        invoiceNote: null,
      });
      expect(
        email.sendAdminEventUnlockCancelledNotification,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          via: 'invoice',
          manualCreditNoteRequired: true,
          invoiceNote: 'RE-2026-014',
        }),
      );
    });

    it('needs no credit note while no invoice was issued yet', async () => {
      const { service, saved } = setup({
        event: paidEvent({
          billingStatus: 'invoice',
          stripeCheckoutSessionId: null,
        }),
      });
      await service.cancelForOrganization(ORG, EVENT_ID, admin, IN_TIME);
      expect(saved[0].manualCreditNoteRequired).toBe(false);
    });
  });

  describe('idempotency', () => {
    it('returns the existing cancellation instead of refunding twice', async () => {
      const previous = {
        id: 'cancel-0',
        eventId: EVENT_ID,
        createdAt: new Date('2026-09-01T09:00:00.000Z'),
      } as EventBillingCancellation;
      const { service, stripe, email, saved } = setup({
        event: paidEvent({ billingStatus: 'none', status: EventStatus.TEST }),
        previousCancellation: previous,
      });

      const result = await service.cancelForOrganization(
        ORG,
        EVENT_ID,
        admin,
        IN_TIME,
      );

      expect(result).toBe(previous);
      expect(stripe.getCheckoutSessionForRefund).not.toHaveBeenCalled();
      expect(saved).toHaveLength(0);
      expect(email.sendEventUnlockCancelledEmail).not.toHaveBeenCalled();
    });

    it('refuses events that were never paid', async () => {
      for (const billingStatus of [
        'none',
        'pending',
        'waived',
      ] as EventBillingStatus[]) {
        const { service } = setup({ event: paidEvent({ billingStatus }) });
        await expect(
          service.cancelForOrganization(ORG, EVENT_ID, admin, IN_TIME),
        ).rejects.toMatchObject({ response: { reason: 'EVENT_NOT_PAID' } });
      }
    });
  });

  describe('describe', () => {
    it('names the deadline and allows cancelling', async () => {
      const { service } = setup();
      const info = await service.describe(paidEvent(), organization(), IN_TIME);
      expect(info).toEqual({
        allowed: true,
        deadline: '2026-09-04T15:00:00.000Z',
        timezone: BERLIN,
        blockedReason: null,
      });
    });

    it('reports the reason when blocked', async () => {
      const late = new Date('2026-09-05T10:00:00.000Z');
      expect(
        (await setup().service.describe(paidEvent(), organization(), late))
          .blockedReason,
      ).toBe('deadline_passed');
      expect(
        (
          await setup({ realOrders: 1 }).service.describe(
            paidEvent(),
            organization(),
            IN_TIME,
          )
        ).blockedReason,
      ).toBe('has_orders');
      expect(
        (
          await setup({ stripeConfigured: false }).service.describe(
            paidEvent(),
            organization(),
            IN_TIME,
          )
        ).blockedReason,
      ).toBe('online_refund_unavailable');
      const unpaid = await setup().service.describe(
        paidEvent({ billingStatus: 'none' }),
        organization(),
        IN_TIME,
      );
      // Auch ohne Bezahlung steht die Frist da — fuer den Bezahldialog.
      expect(unpaid).toMatchObject({
        allowed: false,
        blockedReason: 'not_paid',
        deadline: '2026-09-04T15:00:00.000Z',
      });
    });
  });

  describe('refund webhook', () => {
    it('records the new status and alerts the operator when a refund fails', async () => {
      const { service, cancellationRepository, email } = setup();
      const record = {
        id: 'cancel-1',
        eventId: EVENT_ID,
        organizationId: ORG,
        amount: 40,
        refundStatus: 'pending',
      } as EventBillingCancellation;
      cancellationRepository.findOne.mockResolvedValue(record);

      await service.handleRefundUpdate({
        id: 're_1',
        status: 'failed',
        failure_reason: 'expired_or_canceled_card',
      } as Stripe.Refund);

      expect(record.refundStatus).toBe('failed');
      expect(cancellationRepository.save).toHaveBeenCalledWith(record);
      expect(email.sendAdminEventRefundFailedNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          refundId: 're_1',
          failureReason: 'expired_or_canceled_card',
        }),
      );
    });

    it('ignores refunds that do not belong to a cancellation', async () => {
      const { service, cancellationRepository } = setup();
      cancellationRepository.findOne.mockResolvedValue(null);
      await service.handleRefundUpdate({
        id: 're_x',
        status: 'succeeded',
      } as Stripe.Refund);
      expect(cancellationRepository.save).not.toHaveBeenCalled();
    });
  });
});

/**
 * Starterbonus: Eine stornierte Veranstaltung zaehlt nicht mehr als
 * bezahlt — der Erstveranstalter-Nachlass steht wieder zur Verfuegung.
 */
describe('starter bonus after a cancellation', () => {
  function billingService(events: { billingStatus: EventBillingStatus }[]) {
    let statuses: string[] = [];
    const queryBuilder = {
      withDeleted: () => queryBuilder,
      where: () => queryBuilder,
      andWhere: (_sql: string, params?: { statuses?: string[] }) => {
        if (params?.statuses) statuses = params.statuses;
        return queryBuilder;
      },
      getCount: () =>
        Promise.resolve(
          events.filter((e) => statuses.includes(e.billingStatus)).length,
        ),
    };
    const config: Record<string, unknown> = {
      'billing.eventPriceEur': 25,
      'billing.firstEventDiscountPercent': 20,
      'billing.testEventMaxOrders': 25,
    };
    return new EventBillingService(
      {
        createQueryBuilder: () => queryBuilder,
      } as unknown as Repository<Event>,
      {
        findOne: jest.fn().mockResolvedValue(organization()),
      } as unknown as Repository<Organization>,
      { checkPermission: jest.fn() } as unknown as OrganizationsService,
      {} as EmailService,
      {} as PlatformSettingsService,
      { isConfigured: true } as unknown as StripeService,
      {
        get: (key: string, fallback?: unknown) => config[key] ?? fallback,
      } as unknown as ConfigService,
      {} as EventUnlockCancellationService,
    );
  }

  it('counts only paid or invoiced events', () => {
    expect([...EVENT_PAID_BILLING_STATUSES]).toEqual(['paid', 'invoice']);
  });

  it('is gone while the first event is paid and back after cancelling it', async () => {
    const first = { billingStatus: 'paid' as EventBillingStatus };

    const whilePaid = await billingService([first]).previewPrice(
      ORG,
      '2026-10-10',
      undefined,
      admin,
    );
    expect(whilePaid.discountReason).toBeNull();
    expect(whilePaid.finalPrice).toBe(25);

    // Storno setzt die Veranstaltung auf 'none' zurueck.
    first.billingStatus = 'none';
    const afterCancel = await billingService([first]).previewPrice(
      ORG,
      '2026-10-10',
      undefined,
      admin,
    );
    expect(afterCancel.discountReason).toBe('first-event');
    expect(afterCancel.finalPrice).toBe(20);
  });
});

/**
 * Stripe wiederholt Webhooks; bei Lastschrift kommt die Erfolgsmeldung
 * Tage spaeter. Eine stornierte Zahlung darf nicht erneut freischalten.
 */
describe('settling a checkout after its cancellation', () => {
  it('does not unlock the event again', async () => {
    const event = paidEvent({
      billingStatus: 'none',
      stripeCheckoutSessionId: null,
      status: EventStatus.TEST,
    });
    const eventRepository = {
      findOne: jest.fn().mockResolvedValue(event),
      update: jest.fn(),
    };
    const service = new EventBillingService(
      eventRepository as unknown as Repository<Event>,
      {
        findOne: jest.fn().mockResolvedValue(organization()),
      } as unknown as Repository<Organization>,
      {} as OrganizationsService,
      {} as EmailService,
      {} as PlatformSettingsService,
      {
        isConfigured: true,
        getCheckoutSession: jest.fn().mockResolvedValue({
          id: 'cs_paid',
          payment_status: 'paid',
          amount_total: 4000,
          metadata: { eventId: EVENT_ID, days: '2' },
        }),
      } as unknown as StripeService,
      { get: () => undefined } as unknown as ConfigService,
      {
        wasCheckoutCancelled: jest.fn().mockResolvedValue(true),
      } as unknown as EventUnlockCancellationService,
    );

    const result = await service.settleStripePayment('cs_paid');

    expect(eventRepository.update).not.toHaveBeenCalled();
    expect(result?.billingStatus).toBe('none');
  });
});
