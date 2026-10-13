import { Repository } from 'typeorm';
import type Stripe from 'stripe';

import { Event, EventStatus } from '../../database/entities/event.entity';
import { Organization } from '../../database/entities/organization.entity';
import { UserOrganization } from '../../database/entities/user-organization.entity';
import { AdminAction } from '../../database/entities/admin-audit-log.entity';
import { CronLockService } from '../../common/redis/cron-lock.service';
import { StripeService } from '../stripe/stripe.service';
import { EmailService } from '../email/email.service';
import { EventBillingService } from './event-billing.service';
import { BillingAuditService } from './billing-audit.service';
import {
  EventCheckoutLifecycleService,
  STALE_CHECKOUT_AFTER_MS,
} from './event-checkout-lifecycle.service';

/** expect.objectContaining ohne `any` — fuer verschachtelte Erwartungen. */
const containing = (expected: object): unknown =>
  expect.objectContaining(expected);

const ORG = '00000000-0000-4000-8000-000000000001';
const EVENT_ID = '00000000-0000-4000-8000-0000000000e1';
const NOW = new Date('2026-10-14T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function pendingEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: EVENT_ID,
    organizationId: ORG,
    name: 'Sommerfest',
    startDate: new Date('2026-11-20T17:00:00.000Z'),
    endDate: new Date('2026-11-21T01:00:00.000Z'),
    status: EventStatus.TEST,
    billingStatus: 'pending',
    stripeCheckoutSessionId: 'cs_1',
    createdAt: new Date('2026-10-01T10:00:00.000Z'),
    updatedAt: new Date(NOW.getTime() - 2 * HOUR),
    deletedAt: null,
    ...overrides,
  } as unknown as Event;
}

function session(
  overrides: Partial<Stripe.Checkout.Session> = {},
): Stripe.Checkout.Session {
  return {
    id: 'cs_1',
    status: 'open',
    payment_status: 'unpaid',
    created: Math.floor((NOW.getTime() - HOUR) / 1000),
    metadata: { eventId: EVENT_ID },
    payment_intent: null,
    ...overrides,
  } as Stripe.Checkout.Session;
}

function setup(
  options: {
    event?: Event | null;
    events?: Event[];
    affected?: number;
    billingEmail?: string | null;
    admins?: string[];
    stripeConfigured?: boolean;
    retrieved?: Stripe.Checkout.Session | Error;
    expireResult?: Partial<Stripe.Checkout.Session> | Error;
  } = {},
) {
  const event = options.event === undefined ? pendingEvent() : options.event;
  const eventRepository = {
    findOne: jest.fn().mockResolvedValue(event),
    find: jest.fn().mockResolvedValue(options.events ?? (event ? [event] : [])),
    update: jest.fn().mockResolvedValue({ affected: options.affected ?? 1 }),
  };
  const organizationRepository = {
    findOne: jest.fn().mockResolvedValue({
      id: ORG,
      name: 'Musikverein',
      billingEmail:
        options.billingEmail === undefined
          ? 'kasse@example.org'
          : options.billingEmail,
      settings: { timezone: 'Europe/Berlin' },
    }),
  };
  const userOrganizationRepository = {
    find: jest
      .fn()
      .mockResolvedValue(
        (options.admins ?? []).map((email) => ({ user: { email } })),
      ),
  };
  const stripe = {
    isConfigured: options.stripeConfigured ?? true,
    getCheckoutSessionWithPayment: jest.fn(() =>
      options.retrieved instanceof Error
        ? Promise.reject(options.retrieved)
        : Promise.resolve(options.retrieved ?? session()),
    ),
    expireCheckoutSession: jest.fn(() =>
      options.expireResult instanceof Error
        ? Promise.reject(options.expireResult)
        : Promise.resolve({
            id: 'cs_1',
            status: 'expired',
            ...options.expireResult,
          }),
    ),
    isResourceMissing: jest.fn(
      (error: unknown) =>
        (error as { code?: string })?.code === 'resource_missing',
    ),
  };
  const billing = {
    settleStripePayment: jest.fn().mockResolvedValue(null),
  };
  const email = {
    sendEventCheckoutNotCompletedEmail: jest.fn().mockResolvedValue(true),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const cronLock = {
    runExclusive: jest.fn(async (_name: string, job: () => Promise<void>) => {
      await job();
      return true;
    }),
  };

  const service = new EventCheckoutLifecycleService(
    eventRepository as unknown as Repository<Event>,
    organizationRepository as unknown as Repository<Organization>,
    userOrganizationRepository as unknown as Repository<UserOrganization>,
    stripe as unknown as StripeService,
    billing as unknown as EventBillingService,
    email as unknown as EmailService,
    audit as unknown as BillingAuditService,
    cronLock as unknown as CronLockService,
  );
  return {
    service,
    eventRepository,
    stripe,
    billing,
    email,
    audit,
    cronLock,
    userOrganizationRepository,
  };
}

describe('webhook checkout.session.expired', () => {
  it('resets exactly this pending checkout, logs and mails the billing address', async () => {
    const { service, eventRepository, audit, email } = setup();

    const released = await service.handleCheckoutExpired(
      session({ status: 'expired' }),
      'evt_1',
    );

    expect(released).toBe(true);
    expect(eventRepository.update).toHaveBeenCalledWith(
      {
        id: EVENT_ID,
        billingStatus: 'pending',
        stripeCheckoutSessionId: 'cs_1',
      },
      { billingStatus: 'none', stripeCheckoutSessionId: null },
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AdminAction.EVENT_CHECKOUT_RELEASED,
        organizationId: ORG,
        eventId: EVENT_ID,
        details: containing({
          sessionId: 'cs_1',
          reason: 'expired',
          source: 'webhook',
          stripeEventId: 'evt_1',
        }),
      }),
    );
    expect(email.sendEventCheckoutNotCompletedEmail).toHaveBeenCalledTimes(1);
    expect(email.sendEventCheckoutNotCompletedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'kasse@example.org',
        eventName: 'Sommerfest',
        reason: 'expired',
      }),
    );
  });

  it('is idempotent: a repeated delivery changes nothing and sends no mail', async () => {
    const { service, audit, email } = setup({ affected: 0 });

    const released = await service.handleCheckoutExpired(
      session({ status: 'expired' }),
      'evt_1',
    );

    expect(released).toBe(false);
    expect(audit.record).not.toHaveBeenCalled();
    expect(email.sendEventCheckoutNotCompletedEmail).not.toHaveBeenCalled();
  });

  it('leaves a newer checkout or a paid event alone (conditional update on the session)', async () => {
    const { service, eventRepository, email } = setup({
      event: pendingEvent({ stripeCheckoutSessionId: 'cs_new' }),
      affected: 0,
    });
    await service.handleCheckoutExpired(
      session({ id: 'cs_old', status: 'expired' }),
    );
    expect(eventRepository.update).toHaveBeenCalledWith(
      expect.objectContaining({ stripeCheckoutSessionId: 'cs_old' }),
      expect.anything(),
    );
    expect(email.sendEventCheckoutNotCompletedEmail).not.toHaveBeenCalled();
  });

  it('mails all organization admins when there is no billing address', async () => {
    const { service, email } = setup({
      billingEmail: null,
      admins: ['a@example.org', 'b@example.org', 'a@example.org'],
    });
    await service.handleCheckoutExpired(session({ status: 'expired' }));
    const recipients = email.sendEventCheckoutNotCompletedEmail.mock.calls.map(
      ([o]: [{ to: string }]) => o.to,
    );
    expect(recipients).toEqual(['a@example.org', 'b@example.org']);
  });

  it('finds the event by session id when metadata is missing', async () => {
    const { service, eventRepository } = setup();
    await service.handleCheckoutExpired(
      session({ status: 'expired', metadata: {} }),
    );
    expect(eventRepository.findOne).toHaveBeenCalledWith({
      where: { stripeCheckoutSessionId: 'cs_1' },
      withDeleted: true,
    });
  });

  it('does not mail for a deleted event', async () => {
    const { service, email, audit } = setup({
      event: pendingEvent({ deletedAt: new Date() }),
    });
    await service.handleCheckoutExpired(session({ status: 'expired' }));
    expect(audit.record).toHaveBeenCalled();
    expect(email.sendEventCheckoutNotCompletedEmail).not.toHaveBeenCalled();
  });
});

describe('webhook checkout.session.async_payment_failed', () => {
  it('resets the event and passes the bank reason on', async () => {
    const { service, email, audit } = setup({
      retrieved: session({
        status: 'complete',
        payment_status: 'unpaid',
        payment_intent: {
          id: 'pi_1',
          status: 'requires_payment_method',
          last_payment_error: null,
          latest_charge: {
            id: 'ch_1',
            failure_message: 'Das Konto ist erloschen.',
            failure_code: 'account_closed',
          },
        } as unknown as Stripe.PaymentIntent,
      }),
    });

    await service.handleAsyncPaymentFailed(
      session({ status: 'complete' }),
      'evt_2',
    );

    expect(email.sendEventCheckoutNotCompletedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'payment_failed',
        failureReason: 'Das Konto ist erloschen.',
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        details: containing({
          reason: 'payment_failed',
          failureReason: 'Das Konto ist erloschen.',
        }),
      }),
    );
  });

  it('still resets when Stripe cannot tell the reason', async () => {
    const { service, email } = setup({ retrieved: new Error('network') });
    await service.handleAsyncPaymentFailed(session({ status: 'complete' }));
    expect(email.sendEventCheckoutNotCompletedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'payment_failed',
        failureReason: null,
      }),
    );
  });
});

describe('cleanup of stale pending checkouts', () => {
  it('runs under the cron lock', async () => {
    const { service, cronLock } = setup({
      retrieved: session({ status: 'open' }),
    });
    await service.handleStaleCheckouts();
    expect(cronLock.runExclusive).toHaveBeenCalledWith(
      'stale-stripe-checkouts',
      expect.any(Function),
    );
  });

  it('does nothing without Stripe', async () => {
    const { service, eventRepository } = setup({ stripeConfigured: false });
    const summary = await service.cleanupStalePendingCheckouts(NOW);
    expect(summary.checked).toBe(0);
    expect(eventRepository.find).not.toHaveBeenCalled();
  });

  it('releases an expired session (Stripe says expired)', async () => {
    const { service, eventRepository, email } = setup({
      retrieved: session({ status: 'expired' }),
    });
    const summary = await service.cleanupStalePendingCheckouts(NOW);
    expect(summary).toMatchObject({ checked: 1, released: 1 });
    expect(eventRepository.update).toHaveBeenCalledWith(
      expect.objectContaining({ stripeCheckoutSessionId: 'cs_1' }),
      { billingStatus: 'none', stripeCheckoutSessionId: null },
    );
    // Seite vor einer Stunde begonnen: Hinweis an die Organisation.
    expect(email.sendEventCheckoutNotCompletedEmail).toHaveBeenCalled();
  });

  it('releases old leftovers silently (audit only)', async () => {
    const { service, email, audit } = setup({
      retrieved: session({
        status: 'expired',
        created: Math.floor(
          new Date('2026-09-01T10:00:00.000Z').getTime() / 1000,
        ),
      }),
    });
    await service.cleanupStalePendingCheckouts(NOW);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        details: containing({ source: 'cleanup' }),
      }),
    );
    expect(email.sendEventCheckoutNotCompletedEmail).not.toHaveBeenCalled();
  });

  it('keeps a young open session', async () => {
    const { service, eventRepository, stripe } = setup({
      retrieved: session({ status: 'open' }),
    });
    const summary = await service.cleanupStalePendingCheckouts(NOW);
    expect(summary).toMatchObject({ kept: 1, released: 0 });
    expect(stripe.expireCheckoutSession).not.toHaveBeenCalled();
    expect(eventRepository.update).not.toHaveBeenCalled();
  });

  it('expires an open session older than 25 h at Stripe first, then releases', async () => {
    const created = Math.floor(
      (NOW.getTime() - STALE_CHECKOUT_AFTER_MS - HOUR) / 1000,
    );
    const { service, stripe, eventRepository } = setup({
      retrieved: session({ status: 'open', created }),
    });
    const summary = await service.cleanupStalePendingCheckouts(NOW);
    expect(stripe.expireCheckoutSession).toHaveBeenCalledWith('cs_1');
    expect(summary.released).toBe(1);
    const expireOrder =
      stripe.expireCheckoutSession.mock.invocationCallOrder[0];
    const updateOrder = eventRepository.update.mock.invocationCallOrder[0];
    expect(expireOrder).toBeLessThan(updateOrder);
  });

  it('keeps an old open session if Stripe refuses to expire it (maybe just paid)', async () => {
    const created = Math.floor(
      (NOW.getTime() - STALE_CHECKOUT_AFTER_MS - HOUR) / 1000,
    );
    const { service, eventRepository } = setup({
      retrieved: session({ status: 'open', created }),
      expireResult: new Error('session is complete'),
    });
    const summary = await service.cleanupStalePendingCheckouts(NOW);
    expect(summary.kept).toBe(1);
    expect(eventRepository.update).not.toHaveBeenCalled();
  });

  it('settles a complete, paid session whose webhook got lost', async () => {
    const { service, billing, eventRepository } = setup({
      retrieved: session({ status: 'complete', payment_status: 'paid' }),
    });
    const summary = await service.cleanupStalePendingCheckouts(NOW);
    expect(summary.settled).toBe(1);
    expect(billing.settleStripePayment).toHaveBeenCalledWith('cs_1');
    expect(eventRepository.update).not.toHaveBeenCalled();
  });

  it('keeps a complete session while the direct debit is processing', async () => {
    const { service, eventRepository } = setup({
      retrieved: session({
        status: 'complete',
        payment_status: 'unpaid',
        created: Math.floor(
          new Date('2026-10-05T10:00:00.000Z').getTime() / 1000,
        ),
        payment_intent: {
          id: 'pi_1',
          status: 'processing',
        } as Stripe.PaymentIntent,
      }),
    });
    const summary = await service.cleanupStalePendingCheckouts(NOW);
    expect(summary.kept).toBe(1);
    expect(eventRepository.update).not.toHaveBeenCalled();
  });

  it('releases a complete session whose direct debit failed', async () => {
    const { service } = setup({
      retrieved: session({
        status: 'complete',
        payment_status: 'unpaid',
        payment_intent: {
          id: 'pi_1',
          status: 'requires_payment_method',
          last_payment_error: { message: 'insufficient funds' },
        } as unknown as Stripe.PaymentIntent,
      }),
    });
    const summary = await service.cleanupStalePendingCheckouts(NOW);
    expect(summary.released).toBe(1);
  });

  it('releases a session Stripe does not know once it is older than 25 h', async () => {
    const missing = Object.assign(new Error('No such checkout.session'), {
      code: 'resource_missing',
    });
    const old = setup({
      event: pendingEvent({
        updatedAt: new Date(NOW.getTime() - STALE_CHECKOUT_AFTER_MS - HOUR),
      }),
      retrieved: missing,
    });
    expect((await old.service.cleanupStalePendingCheckouts(NOW)).released).toBe(
      1,
    );
    expect(old.email.sendEventCheckoutNotCompletedEmail).not.toHaveBeenCalled();

    const young = setup({ retrieved: missing });
    expect((await young.service.cleanupStalePendingCheckouts(NOW)).kept).toBe(
      1,
    );
  });

  it('counts a Stripe outage as failed and touches nothing', async () => {
    const { service, eventRepository } = setup({
      retrieved: new Error('Stripe down'),
    });
    const summary = await service.cleanupStalePendingCheckouts(NOW);
    expect(summary.failed).toBe(1);
    expect(eventRepository.update).not.toHaveBeenCalled();
  });

  it('releases a pending event without any session after 25 h', async () => {
    const { service, eventRepository, stripe } = setup({
      event: pendingEvent({
        stripeCheckoutSessionId: null,
        updatedAt: new Date(NOW.getTime() - 26 * HOUR),
      }),
    });
    const summary = await service.cleanupStalePendingCheckouts(NOW);
    expect(summary.released).toBe(1);
    expect(stripe.getCheckoutSessionWithPayment).not.toHaveBeenCalled();
    expect(eventRepository.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: EVENT_ID, billingStatus: 'pending' }),
      { billingStatus: 'none', stripeCheckoutSessionId: null },
    );
  });
});
