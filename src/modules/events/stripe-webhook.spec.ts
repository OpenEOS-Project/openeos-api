import { Repository } from 'typeorm';
import type Stripe from 'stripe';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';

import { Event, EventStatus } from '../../database/entities/event.entity';
import { Organization } from '../../database/entities/organization.entity';
import { AdminAction } from '../../database/entities/admin-audit-log.entity';
import { StripeService } from '../stripe/stripe.service';
import { EmailService } from '../email/email.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { EventBillingService } from './event-billing.service';
import { EventUnlockCancellationService } from './event-unlock-cancellation.service';
import { EventCheckoutLifecycleService } from './event-checkout-lifecycle.service';
import { BillingAuditService } from './billing-audit.service';
import { StripeDisputeService } from './stripe-dispute.service';
import {
  STRIPE_WEBHOOK_EVENTS,
  StripeWebhookController,
} from './stripe-webhook.controller';

/** expect.objectContaining ohne `any` — fuer verschachtelte Erwartungen. */
const containing = (expected: object): unknown =>
  expect.objectContaining(expected);

const ORG = '00000000-0000-4000-8000-000000000001';
const EVENT_ID = '00000000-0000-4000-8000-0000000000e1';

function stripeEvent(type: string, object: object, id = 'evt_1'): Stripe.Event {
  return { id, type, data: { object } } as unknown as Stripe.Event;
}

describe('StripeWebhookController dispatch', () => {
  function setup(event: Stripe.Event) {
    const stripe = { constructWebhookEvent: jest.fn().mockReturnValue(event) };
    const billing = { settleStripePayment: jest.fn() };
    const cancellation = { handleRefundUpdate: jest.fn() };
    const lifecycle = {
      handleCheckoutExpired: jest.fn(),
      handleAsyncPaymentFailed: jest.fn(),
    };
    const disputes = { handleDispute: jest.fn() };
    const controller = new StripeWebhookController(
      stripe as unknown as StripeService,
      billing as unknown as EventBillingService,
      cancellation as unknown as EventUnlockCancellationService,
      lifecycle as unknown as EventCheckoutLifecycleService,
      disputes as unknown as StripeDisputeService,
    );
    const request = {
      rawBody: Buffer.from('{}'),
    } as unknown as RawBodyRequest<Request>;
    return { controller, request, billing, cancellation, lifecycle, disputes };
  }

  it.each([
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded',
  ])('%s settles the payment', async (type) => {
    const t = setup(stripeEvent(type, { id: 'cs_1' }));
    await expect(t.controller.handleWebhook(t.request, 'sig')).resolves.toEqual(
      { received: true },
    );
    expect(t.billing.settleStripePayment).toHaveBeenCalledWith('cs_1');
  });

  it('checkout.session.expired releases the checkout', async () => {
    const session = { id: 'cs_1', status: 'expired' };
    const t = setup(stripeEvent('checkout.session.expired', session, 'evt_9'));
    await t.controller.handleWebhook(t.request, 'sig');
    expect(t.lifecycle.handleCheckoutExpired).toHaveBeenCalledWith(
      session,
      'evt_9',
    );
    expect(t.billing.settleStripePayment).not.toHaveBeenCalled();
  });

  it('checkout.session.async_payment_failed releases the checkout', async () => {
    const session = { id: 'cs_1', status: 'complete' };
    const t = setup(
      stripeEvent('checkout.session.async_payment_failed', session, 'evt_8'),
    );
    await t.controller.handleWebhook(t.request, 'sig');
    expect(t.lifecycle.handleAsyncPaymentFailed).toHaveBeenCalledWith(
      session,
      'evt_8',
    );
  });

  it.each(['refund.updated', 'refund.failed'])(
    '%s updates the refund state',
    async (type) => {
      const refund = { id: 're_1', status: 'failed' };
      const t = setup(stripeEvent(type, refund));
      await t.controller.handleWebhook(t.request, 'sig');
      expect(t.cancellation.handleRefundUpdate).toHaveBeenCalledWith(refund);
    },
  );

  it.each([
    ['charge.dispute.created', 'created'],
    ['charge.dispute.closed', 'closed'],
  ])('%s alerts the operator', async (type, phase) => {
    const dispute = { id: 'dp_1' };
    const t = setup(stripeEvent(type, dispute, 'evt_7'));
    await t.controller.handleWebhook(t.request, 'sig');
    expect(t.disputes.handleDispute).toHaveBeenCalledWith(
      dispute,
      phase,
      'evt_7',
    );
  });

  it('acknowledges unknown events without doing anything', async () => {
    const t = setup(stripeEvent('customer.created', { id: 'cus_1' }));
    await expect(t.controller.handleWebhook(t.request, 'sig')).resolves.toEqual(
      { received: true },
    );
    expect(t.billing.settleStripePayment).not.toHaveBeenCalled();
    expect(t.disputes.handleDispute).not.toHaveBeenCalled();
  });

  it('documents every handled event', () => {
    expect([...STRIPE_WEBHOOK_EVENTS].sort()).toEqual(
      [
        'charge.dispute.closed',
        'charge.dispute.created',
        'checkout.session.async_payment_failed',
        'checkout.session.async_payment_succeeded',
        'checkout.session.completed',
        'checkout.session.expired',
        'refund.failed',
        'refund.updated',
      ].sort(),
    );
  });
});

describe('StripeDisputeService', () => {
  function dispute(overrides: Partial<Stripe.Dispute> = {}): Stripe.Dispute {
    return {
      id: 'dp_1',
      amount: 4000,
      currency: 'eur',
      reason: 'fraudulent',
      status: 'needs_response',
      charge: 'ch_1',
      payment_intent: 'pi_1',
      evidence_details: { due_by: 1792000000 },
      ...overrides,
    } as unknown as Stripe.Dispute;
  }

  function setup(options: { seen?: boolean; adminEmail?: string | null } = {}) {
    const eventRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: EVENT_ID,
        organizationId: ORG,
        name: 'Sommerfest',
      }),
    };
    const organizationRepository = {
      findOne: jest.fn().mockResolvedValue({ id: ORG, name: 'Musikverein' }),
    };
    const stripe = {
      getPaymentIntent: jest.fn().mockResolvedValue({
        id: 'pi_1',
        metadata: { eventId: EVENT_ID, organizationId: ORG },
      }),
    };
    const email = { sendAdminBillingAlert: jest.fn().mockResolvedValue(true) };
    const settings = {
      resolvePlatformAdminEmail: jest
        .fn()
        .mockResolvedValue(
          options.adminEmail === undefined
            ? 'ops@openeos.de'
            : options.adminEmail,
        ),
    };
    const audit = {
      record: jest.fn().mockResolvedValue(undefined),
      hasEntryWithDetail: jest.fn().mockResolvedValue(options.seen ?? false),
    };
    const service = new StripeDisputeService(
      eventRepository as unknown as Repository<Event>,
      organizationRepository as unknown as Repository<Organization>,
      stripe as unknown as StripeService,
      email as unknown as EmailService,
      settings as unknown as PlatformSettingsService,
      audit as unknown as BillingAuditService,
    );
    return { service, email, audit, stripe, eventRepository };
  }

  it('dispute created: audit entry and mail with organization, event, amount, reason', async () => {
    const { service, email, audit } = setup();
    await service.handleDispute(dispute(), 'created', 'evt_d1');

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AdminAction.EVENT_PAYMENT_DISPUTE_OPENED,
        organizationId: ORG,
        eventId: EVENT_ID,
        details: containing({
          stripeEventId: 'evt_d1',
          disputeId: 'dp_1',
          amount: 40,
          currency: 'EUR',
          reason: 'fraudulent',
        }),
      }),
    );
    const mail = (
      email.sendAdminBillingAlert.mock.calls as unknown[][]
    )[0][0] as {
      to: string;
      subject: string;
      rows: [string, string][];
    };
    expect(mail.to).toBe('ops@openeos.de');
    expect(mail.subject).toContain('Rückbuchung eröffnet');
    const rows = Object.fromEntries(mail.rows);
    expect(rows.Organisation).toBe('Musikverein');
    expect(rows.Veranstaltung).toBe('Sommerfest');
    expect(rows.Betrag).toMatch(/40,00\s€/);
    expect(rows.Grund).toContain('fraudulent');
    expect(rows['Nachweise bis']).toBeDefined();
  });

  it('dispute closed: own action and the outcome in the subject', async () => {
    const { service, email, audit } = setup();
    await service.handleDispute(dispute({ status: 'won' }), 'closed', 'evt_d2');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AdminAction.EVENT_PAYMENT_DISPUTE_CLOSED,
      }),
    );
    expect(
      (
        (email.sendAdminBillingAlert.mock.calls as unknown[][])[0][0] as {
          subject: string;
        }
      ).subject,
    ).toContain('gewonnen');
  });

  it('a repeated delivery of the same Stripe event sends nothing', async () => {
    const { service, email, audit } = setup({ seen: true });
    await service.handleDispute(dispute(), 'created', 'evt_d1');
    expect(audit.record).not.toHaveBeenCalled();
    expect(email.sendAdminBillingAlert).not.toHaveBeenCalled();
  });

  it('still logs a dispute that belongs to no event', async () => {
    const { service, audit, stripe, eventRepository, email } = setup();
    stripe.getPaymentIntent.mockResolvedValue({ id: 'pi_x', metadata: {} });
    await service.handleDispute(dispute(), 'created', 'evt_d3');
    expect(eventRepository.findOne).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: null, organizationId: null }),
    );
    expect(email.sendAdminBillingAlert).toHaveBeenCalled();
  });

  it('does not lock the event (no write to the event)', async () => {
    const { service, eventRepository } = setup();
    await service.handleDispute(dispute(), 'created', 'evt_d4');
    expect(Object.keys(eventRepository)).toEqual(['findOne']);
  });
});

describe('settleStripePayment around expired checkouts', () => {
  function setup(event: Event, sessionId = 'cs_old') {
    const eventRepository = {
      findOne: jest.fn().mockResolvedValue(event),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const stripe = {
      isConfigured: true,
      getCheckoutSession: jest.fn().mockResolvedValue({
        id: sessionId,
        payment_status: 'paid',
        amount_total: 2500,
        currency: 'eur',
        metadata: { eventId: EVENT_ID, days: '1' },
      }),
      expireCheckoutSession: jest.fn().mockResolvedValue({ status: 'expired' }),
    };
    const email = { sendAdminBillingAlert: jest.fn().mockResolvedValue(true) };
    const settings = {
      resolveNotificationTarget: jest.fn().mockResolvedValue(null),
      resolvePlatformAdminEmail: jest.fn().mockResolvedValue('ops@openeos.de'),
    };
    const audit = {
      record: jest.fn().mockResolvedValue(undefined),
      hasEntryWithDetail: jest.fn().mockResolvedValue(false),
    };
    const service = new EventBillingService(
      eventRepository as unknown as Repository<Event>,
      {
        findOne: jest.fn().mockResolvedValue({ id: ORG, name: 'Musikverein' }),
      } as unknown as Repository<Organization>,
      {} as OrganizationsService,
      email as unknown as EmailService,
      settings as unknown as PlatformSettingsService,
      stripe as unknown as StripeService,
      { get: () => undefined } as unknown as ConfigService,
      {
        wasCheckoutCancelled: jest.fn().mockResolvedValue(false),
      } as unknown as EventUnlockCancellationService,
      audit as unknown as BillingAuditService,
    );
    return { service, eventRepository, stripe, email, audit };
  }

  it('a late success after the reset still unlocks the event', async () => {
    const { service, eventRepository } = setup({
      id: EVENT_ID,
      organizationId: ORG,
      name: 'Sommerfest',
      status: EventStatus.TEST,
      billingStatus: 'none',
      stripeCheckoutSessionId: null,
      startDate: new Date('2026-11-20T17:00:00.000Z'),
      endDate: null,
    } as unknown as Event);

    const result = await service.settleStripePayment('cs_old');

    expect(eventRepository.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: EVENT_ID }),
      expect.objectContaining({
        billingStatus: 'paid',
        stripeCheckoutSessionId: 'cs_old',
        priceCharged: 25,
      }),
    );
    expect(result?.billingStatus).toBe('paid');
  });

  it('closes a newer open checkout when an older one gets paid', async () => {
    const { service, stripe } = setup({
      id: EVENT_ID,
      organizationId: ORG,
      name: 'Sommerfest',
      billingStatus: 'pending',
      stripeCheckoutSessionId: 'cs_new',
      startDate: new Date('2026-11-20T17:00:00.000Z'),
      endDate: null,
    } as unknown as Event);

    await service.settleStripePayment('cs_old');

    expect(stripe.expireCheckoutSession).toHaveBeenCalledWith('cs_new');
  });

  it('alerts the operator about a payment for an already unlocked event', async () => {
    const { service, eventRepository, email, audit } = setup({
      id: EVENT_ID,
      organizationId: ORG,
      name: 'Sommerfest',
      billingStatus: 'paid',
      stripeCheckoutSessionId: 'cs_new',
    } as unknown as Event);

    await service.settleStripePayment('cs_old');

    expect(eventRepository.update).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AdminAction.EVENT_DUPLICATE_PAYMENT,
        details: containing({ sessionId: 'cs_old' }),
      }),
    );
    expect(email.sendAdminBillingAlert).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'ops@openeos.de' }),
    );
  });

  it('does not alert for the event’s own session (webhook + browser return)', async () => {
    const { service, email } = setup(
      {
        id: EVENT_ID,
        organizationId: ORG,
        name: 'Sommerfest',
        billingStatus: 'paid',
        stripeCheckoutSessionId: 'cs_old',
      } as unknown as Event,
      'cs_old',
    );
    await service.settleStripePayment('cs_old');
    expect(email.sendAdminBillingAlert).not.toHaveBeenCalled();
  });
});
