import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';

import { AdminAuditLog } from '../../database/entities/admin-audit-log.entity';
import { Event } from '../../database/entities/event.entity';
import { OrganizationOperatingModeChange } from '../../database/entities/organization-operating-mode-change.entity';
import { Organization } from '../../database/entities/organization.entity';
import { User } from '../../database/entities';
import { OrganizationsService } from '../organizations/organizations.service';
import { StripeService } from '../stripe/stripe.service';
import { EmailService } from '../email/email.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { EventBillingService } from '../events/event-billing.service';
import { BillingAuditService } from '../events/billing-audit.service';
import { EventUnlockCancellationService } from '../events/event-unlock-cancellation.service';
import { StripeInvoiceService } from '../events/stripe-invoice.service';
import {
  TseAutoActivationService,
  autoCreationDay,
  tseAutoEnabledInfo,
} from './tse-auto-activation.service';
import { TseConfig } from './tse.config';
import { TseNotifyService } from './tse-notify.service';
import { TseUnitService } from './tse-unit.service';

/**
 * Cloud-TSE „All inclusive“ (Entscheidung 2026-11-03): Matrix aus Art der
 * Organisation × Weg der Freischaltung → Integration an/aus und
 * automatische Anlage geplant bzw. sofort angestossen. Dazu der
 * Preis-Haken TSE_EVENT_SURCHARGE_EUR (0 vs. > 0).
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const EVENT_ID = '00000000-0000-4000-8000-0000000000e1';
const NOW = new Date('2026-11-03T10:00:00.000Z');

const admin = { id: 'user-1', email: 'admin@example.org' } as User;

type Kind =
  | 'de-full'
  | 'de-legacy-yes'
  | 'de-legacy-no'
  | 'de-cashless'
  | 'de-orders-only'
  | 'at-full';
type Path = 'checkout' | 'invoice' | 'waived';

function orgFor(kind: Kind): Organization {
  const base = {
    id: ORG,
    name: 'Musikverein Harmonie e.V.',
    billingMode: 'prepaid',
    billingEmail: 'kasse@example.org',
    // Pflichtangaben beim Kauf (offizieller Name, Rechnungsanschrift).
    billingAddress: {
      name: 'Musikverein Harmonie e.V.',
      street: 'Hauptstr. 1',
      zip: '12345',
      city: 'Musterstadt',
      country: 'DE',
    },
    eventPriceOverride: null,
    discountPercent: null,
    discountValidUntil: null,
    stripeCustomerId: 'cus_1',
    tseActive: false,
    country: 'DE',
    operatingMode: 'full',
    operatingModeLegacy: false,
    operatingModeSince: new Date('2026-10-01T10:00:00Z'),
    settings: {
      timezone: 'Europe/Berlin',
      currency: 'EUR',
      legalName: 'Musikverein Harmonie e.V.',
      taxNumber: '12/345/67890',
      address: { street: 'Hauptstr. 1', zip: '12345', city: 'Musterstadt' },
    },
  } as unknown as Organization;
  switch (kind) {
    case 'de-full':
      return base;
    case 'de-legacy-yes':
    case 'de-legacy-no':
      return { ...base, operatingModeLegacy: true } as Organization;
    case 'de-cashless':
      return { ...base, operatingMode: 'cashless' } as Organization;
    case 'de-orders-only':
      return { ...base, operatingMode: 'orders_only' } as Organization;
    case 'at-full':
      return { ...base, country: 'AT' } as Organization;
  }
}

const answerOf = (kind: Kind): boolean | undefined =>
  kind === 'de-legacy-yes' ? true : kind === 'de-legacy-no' ? false : undefined;

function setup(
  kind: Kind,
  options: {
    surcharge?: number;
    tseAvailable?: boolean;
    eventStart?: Date;
    alreadyEnabled?: boolean;
  } = {},
) {
  const org = orgFor(kind);
  if (options.alreadyEnabled) {
    (org.settings as unknown as Record<string, unknown>).integrations = {
      tse: { enabled: true, enabledAt: '2026-10-01T00:00:00.000Z' },
    };
  }
  const eventStart = options.eventStart ?? new Date('2026-12-12T15:00:00Z');
  const event = {
    id: EVENT_ID,
    organizationId: ORG,
    name: 'Weihnachtsmarkt',
    startDate: eventStart,
    endDate: new Date(eventStart.getTime() + 8 * 3600_000),
    billingStatus: 'none',
    priceCharged: null,
    billedDays: null,
    tseIncluded: null,
    tseSurcharge: null,
    stripeCheckoutSessionId: null,
  } as unknown as Event;

  // ---- Datenbank im Speicher (nur was der TSE-Dienst anfasst)
  const audit: Partial<AdminAuditLog>[] = [];
  const history: Partial<OrganizationOperatingModeChange>[] = [];
  const query = jest.fn((sql: string, params: unknown[] = []) => {
    if (sql.includes('FOR UPDATE')) {
      return Promise.resolve([
        {
          country: org.country,
          operating_mode: org.operatingMode,
          operating_mode_legacy: org.operatingModeLegacy,
          tse_active: false,
          settings: org.settings,
        },
      ]);
    }
    if (sql.includes("jsonb_build_object('tse'")) {
      const settings = org.settings as unknown as {
        integrations?: Record<string, { enabled?: boolean }>;
      };
      if (settings.integrations?.tse?.enabled === true) {
        return Promise.resolve([]);
      }
      settings.integrations = {
        ...(settings.integrations ?? {}),
        tse: JSON.parse(params[1] as string) as { enabled: boolean },
      };
      return Promise.resolve([{ id: ORG }]);
    }
    if (sql.includes('operating_mode_legacy = false')) {
      if (org.operatingMode !== 'full' || !org.operatingModeLegacy) {
        return Promise.resolve([]);
      }
      org.operatingModeLegacy = false;
      return Promise.resolve([{ id: ORG }]);
    }
    if (sql.includes('SELECT id, settings FROM organizations')) {
      return Promise.resolve([{ id: ORG, settings: org.settings }]);
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const manager = {
    query,
    insert: jest.fn((entity: unknown, row: object) => {
      if (entity === OrganizationOperatingModeChange) history.push(row);
      return Promise.resolve();
    }),
    getRepository: jest.fn(() => ({
      create: (row: Partial<AdminAuditLog>) => row,
      save: (row: Partial<AdminAuditLog>) => {
        audit.push(row);
        return Promise.resolve(row);
      },
    })),
  };
  const dataSource = {
    query,
    transaction: jest.fn((work: (m: typeof manager) => Promise<unknown>) =>
      work(manager),
    ),
  };

  const unlocked = () =>
    ['paid', 'invoice', 'waived'].includes(event.billingStatus);
  const units = {
    qualifyingEvents: jest.fn(() =>
      Promise.resolve(
        unlocked()
          ? [
              {
                id: event.id,
                name: event.name,
                startDate: event.startDate,
                endDate: event.endDate,
              },
            ]
          : [],
      ),
    ),
    // Wie der SQL-Filter: beginnt vor morgen 6 Uhr und laeuft noch.
    autoCreate: jest.fn((now: Date, organizationId: string | null) => {
      const integrations = (
        org.settings as unknown as {
          integrations?: { tse?: { enabled?: boolean } };
        }
      ).integrations;
      const due =
        organizationId === ORG &&
        integrations?.tse?.enabled === true &&
        unlocked() &&
        (event.startDate as Date).getTime() < now.getTime() + 20 * 3600_000;
      return Promise.resolve(due ? ['unit-1'] : []);
    }),
  };
  const notify = { settingsChanged: jest.fn() };
  const config: Record<string, unknown> = {
    'billing.eventPriceEur': 25,
    'billing.firstEventDiscountPercent': 20,
    'billing.testEventMaxOrders': 25,
    'billing.tseEventSurchargeEur': options.surcharge ?? 0,
  };
  const configService = {
    get: (key: string, fallback?: unknown) => config[key] ?? fallback,
  } as unknown as ConfigService;
  const tseConfig = {
    enabled: options.tseAvailable ?? true,
  } as unknown as TseConfig;

  const tseAuto = new TseAutoActivationService(
    dataSource as never,
    tseConfig,
    units as unknown as TseUnitService,
    notify as unknown as TseNotifyService,
    configService,
  );

  // ---- Abrechnung
  const queryBuilder = {
    withDeleted: () => queryBuilder,
    where: () => queryBuilder,
    andWhere: () => queryBuilder,
    getCount: () => Promise.resolve(1),
  };
  const eventRepository = {
    findOne: jest.fn(() => Promise.resolve(event)),
    save: jest.fn((e: Event) => Promise.resolve(e)),
    update: jest.fn((_where: unknown, values: Partial<Event>) => {
      Object.assign(event, values);
      return Promise.resolve({ affected: 1 });
    }),
    createQueryBuilder: () => queryBuilder,
  };
  const organizationRepository = {
    findOne: jest.fn(() => Promise.resolve(org)),
    save: jest.fn((o: Organization) => Promise.resolve(o)),
  };
  let sessionMetadata: Record<string, string> = {};
  let sessionAmount = 0;
  const stripe = {
    isConfigured: true,
    ensureCustomer: jest.fn().mockResolvedValue('cus_1'),
    createCheckoutSession: jest.fn(
      (params: {
        amountInCents: number;
        metadata: Record<string, string>;
        extraLines?: { amountInCents: number }[];
      }) => {
        sessionMetadata = params.metadata;
        sessionAmount =
          params.amountInCents +
          (params.extraLines ?? []).reduce((s, l) => s + l.amountInCents, 0);
        return Promise.resolve({ id: 'cs_1', url: 'https://stripe.test/cs_1' });
      },
    ),
    getCheckoutSession: jest.fn(() =>
      Promise.resolve({
        id: 'cs_1',
        payment_status: 'paid',
        amount_total: sessionAmount,
        currency: 'eur',
        metadata: sessionMetadata,
      }),
    ),
  };
  const invoiceService = {
    isAvailable: true,
    daysUntilDue: () => 14,
    issue: jest.fn().mockResolvedValue({
      customerId: 'cus_1',
      snapshot: {
        stripeInvoiceId: 'in_1',
        stripeInvoiceNumber: 'INV-1',
        invoiceStatus: 'open',
        invoiceDueAt: null,
        invoiceHostedUrl: null,
        invoicePdfUrl: null,
      },
    }),
  };
  const billing = new EventBillingService(
    eventRepository as unknown as Repository<Event>,
    organizationRepository as unknown as Repository<Organization>,
    {
      checkPermission: jest.fn(),
      checkRole: jest.fn(),
    } as unknown as OrganizationsService,
    {
      sendEventInvoiceIssuedEmail: jest.fn().mockResolvedValue(true),
    } as unknown as EmailService,
    {
      resolveNotificationTarget: jest.fn().mockResolvedValue(null),
    } as unknown as PlatformSettingsService,
    stripe as unknown as StripeService,
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
    invoiceService as unknown as StripeInvoiceService,
    tseAuto,
  );

  /** Freischalten auf dem gewaehlten Weg (wie Oberflaeche bzw. Support). */
  async function unlock(path: Path, withTse = answerOf(kind)) {
    if (path === 'checkout') {
      await billing.createStripeCheckout(ORG, EVENT_ID, admin, { withTse });
      await billing.settleStripePayment('cs_1');
    } else if (path === 'invoice') {
      org.billingMode = 'invoice';
      await billing.orderInvoice(
        ORG,
        EVENT_ID,
        {
          billingName: 'Musikverein Harmonie e.V.',
          billingEmail: 'kasse@example.org',
          billingAddress: {
            street: 'Hauptstr. 1',
            zip: '12345',
            city: 'Musterstadt',
          },
          withTse,
        },
        admin,
      );
    } else {
      event.billingStatus = 'waived';
      await billing.afterWaive(event, withTse, 'support-1');
    }
  }

  const integration = () =>
    (
      org.settings as unknown as {
        integrations?: { tse?: Record<string, unknown> };
      }
    ).integrations?.tse ?? null;

  return {
    org,
    event,
    billing,
    tseAuto,
    unlock,
    integration,
    audit,
    history,
    units,
    notify,
    stripe,
    invoiceService,
  };
}

beforeAll(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterAll(() => {
  jest.useRealTimers();
});

describe('Cloud-TSE all inclusive: organization × unlock path', () => {
  const expectations: Record<
    Kind,
    { enabled: boolean; modeSwitched: boolean; included: boolean | null }
  > = {
    'de-full': { enabled: true, modeSwitched: false, included: true },
    'de-legacy-yes': { enabled: true, modeSwitched: true, included: true },
    'de-legacy-no': { enabled: false, modeSwitched: false, included: false },
    'de-cashless': { enabled: false, modeSwitched: false, included: null },
    'de-orders-only': { enabled: false, modeSwitched: false, included: null },
    'at-full': { enabled: false, modeSwitched: false, included: null },
  };
  const kinds = Object.keys(expectations) as Kind[];
  const paths: Path[] = ['checkout', 'invoice', 'waived'];

  for (const kind of kinds) {
    for (const path of paths) {
      const want = expectations[kind];
      it(`${kind} × ${path} → integration ${want.enabled ? 'on, creation planned' : 'unchanged'}`, async () => {
        const t = setup(kind);
        await t.unlock(path);

        expect(t.event.tseIncluded).toBe(want.included);
        expect(t.event.tseSurcharge).toBeNull();
        if (want.enabled) {
          expect(t.integration()).toMatchObject({
            enabled: true,
            auto: {
              source: 'purchase',
              eventId: EVENT_ID,
              eventName: 'Weihnachtsmarkt',
              path,
            },
          });
          const entry = t.audit.find(
            (a) => a.action === ('tse_integration_enabled' as never),
          );
          expect(entry).toMatchObject({
            organizationId: ORG,
            reason: 'automatisch beim Kauf',
            adminUserId:
              path === 'checkout'
                ? null
                : path === 'waived'
                  ? 'support-1'
                  : admin.id,
          });
          // Auto-Anlage: sofortiger Versuch fuer diese Organisation (die
          // Veranstaltung ist erst im Dezember → nichts angelegt, der
          // stuendliche Lauf legt sie am 12.12. an).
          expect(t.units.autoCreate).toHaveBeenCalledWith(
            expect.any(Date),
            ORG,
          );
          expect(await t.units.autoCreate.mock.results[0].value).toEqual([]);
          expect(await t.tseAuto.planFor(t.org)).toMatchObject({
            eventId: EVENT_ID,
            // 12.12. 16:00 → echt ab 11.12. 18:00, TSE am 11.12. (Phasen)
            scheduledFor: '2026-12-11',
            missing: [],
          });
          expect(t.notify.settingsChanged).toHaveBeenCalledWith(ORG);
        } else {
          expect(t.integration()).toBeNull();
          expect(t.units.autoCreate).not.toHaveBeenCalled();
          expect(t.audit).toHaveLength(0);
        }

        expect(t.org.operatingModeLegacy).toBe(
          kind.startsWith('de-legacy') && !want.modeSwitched,
        );
        if (want.modeSwitched) {
          expect(t.history).toEqual([
            expect.objectContaining({
              fromMode: 'full_legacy',
              toMode: 'full',
              reason: 'Cloud-TSE beim Kauf von „Weihnachtsmarkt“ gewählt',
            }),
          ]);
        } else {
          expect(t.history).toHaveLength(0);
        }
      });
    }
  }

  it('starts the TSE right away when the event already runs', async () => {
    const t = setup('de-full', {
      eventStart: new Date(NOW.getTime() - 2 * 3600_000),
    });
    await t.unlock('checkout');
    expect(await t.units.autoCreate.mock.results[0].value).toEqual(['unit-1']);
    expect((await t.tseAuto.planFor(t.org))?.scheduledFor).toBe('2026-11-03');
  });

  it('does nothing when the server offers no Cloud-TSE', async () => {
    const t = setup('de-full', { tseAvailable: false });
    await t.unlock('invoice');
    expect(t.integration()).toBeNull();
    expect(t.event.tseIncluded).toBeNull();
    expect(t.units.autoCreate).not.toHaveBeenCalled();
  });

  it('keeps a manually enabled integration as it is (no second audit entry)', async () => {
    const t = setup('de-full', { alreadyEnabled: true });
    await t.unlock('checkout');
    expect(t.integration()).toEqual({
      enabled: true,
      enabledAt: '2026-10-01T00:00:00.000Z',
    });
    expect(t.audit).toHaveLength(0);
    // Die Anlage wird trotzdem angestossen (laeuft schon / heute).
    expect(t.units.autoCreate).toHaveBeenCalledWith(expect.any(Date), ORG);
  });

  it('is idempotent: a second unlock signal changes nothing', async () => {
    const t = setup('de-legacy-yes');
    await t.unlock('checkout');
    await t.billing.settleStripePayment('cs_1');
    expect(
      t.audit.filter((a) => a.action === ('tse_integration_enabled' as never)),
    ).toHaveLength(1);
    expect(t.history).toHaveLength(1);
  });

  it('a legacy organization keeps cash without TSE when it does not answer', async () => {
    const t = setup('de-legacy-no');
    await t.unlock('checkout', undefined);
    expect(t.org.operatingModeLegacy).toBe(true);
    expect(t.integration()).toBeNull();
    expect(t.event.tseIncluded).toBe(false);
  });

  it('waive falls back to the answer of an earlier checkout page', async () => {
    const t = setup('de-legacy-yes');
    t.event.tseIncluded = true; // aus einer frueheren Zahlungsseite
    t.event.billingStatus = 'waived';
    await t.billing.afterWaive(t.event, undefined, 'support-1');
    expect(t.org.operatingModeLegacy).toBe(false);
    expect(t.integration()).toMatchObject({ enabled: true });
  });
});

describe('Cloud-TSE price hook TSE_EVENT_SURCHARGE_EUR', () => {
  it('0 € → no extra line, no metadata, nothing stored', async () => {
    const t = setup('de-full', { surcharge: 0 });
    await t.unlock('checkout');
    const params = (
      t.stripe.createCheckoutSession.mock.calls[0] as unknown[]
    )[0] as {
      amountInCents: number;
      extraLines?: unknown[];
      metadata: Record<string, string>;
      idempotencyKey: string;
    };
    expect(params.extraLines).toBeUndefined();
    expect(params.metadata).toMatchObject({ withTse: 'true' });
    expect(params.metadata.tseSurcharge).toBeUndefined();
    expect(t.event.priceCharged).toBe(25);
    const info = await t.billing.getBillingInfo(ORG, EVENT_ID, admin);
    expect(info.tse).toMatchObject({
      offer: 'included',
      surcharge: 0,
      included: true,
      surchargeCharged: null,
    });
  });

  it('> 0 € → one "Cloud-TSE" line per event in checkout, stored and part of the charged amount', async () => {
    const t = setup('de-full', {
      surcharge: 4.5,
      eventStart: new Date('2026-12-12T15:00:00Z'),
    });
    // Zwei Veranstaltungstage: der Zuschlag gilt trotzdem nur einmal.
    t.event.endDate = new Date('2026-12-13T20:00:00Z');
    await t.unlock('checkout');
    const params = (
      t.stripe.createCheckoutSession.mock.calls[0] as unknown[]
    )[0] as {
      amountInCents: number;
      extraLines?: { name: string; amountInCents: number }[];
      metadata: Record<string, string>;
      idempotencyKey: string;
    };
    expect(params.amountInCents).toBe(5000);
    expect(params.extraLines).toEqual([
      expect.objectContaining({ name: 'Cloud-TSE', amountInCents: 450 }),
    ]);
    expect(params.metadata).toMatchObject({
      withTse: 'true',
      tseSurcharge: '4.5',
    });
    expect(params.idempotencyKey).toBe(
      `event-checkout:${EVENT_ID}:50:2d:tse1:4.5`,
    );
    expect(t.event).toMatchObject({
      billingStatus: 'paid',
      priceCharged: 54.5,
      tseIncluded: true,
      tseSurcharge: 4.5,
    });
    const info = await t.billing.getBillingInfo(ORG, EVENT_ID, admin);
    // Veranstaltungspreis ohne Zuschlag, der Zuschlag daneben.
    expect(info.finalPrice).toBe(50);
    expect(info.priceCharged).toBe(54.5);
    expect(info.tse).toMatchObject({ surchargeCharged: 4.5, included: true });
  });

  it('> 0 € → invoice gets the surcharge, the charged amount includes it', async () => {
    const t = setup('de-legacy-yes', { surcharge: 4.5 });
    await t.unlock('invoice');
    expect(t.invoiceService.issue).toHaveBeenCalledWith(
      expect.objectContaining({ tseSurcharge: 4.5 }),
    );
    expect(t.event).toMatchObject({
      billingStatus: 'invoice',
      priceCharged: 29.5,
      tseSurcharge: 4.5,
    });
  });

  it('> 0 € but legacy answering no / cashless / AT → no surcharge', async () => {
    for (const kind of ['de-legacy-no', 'de-cashless', 'at-full'] as Kind[]) {
      const t = setup(kind, { surcharge: 4.5 });
      await t.unlock('checkout');
      const params = (
        t.stripe.createCheckoutSession.mock.calls[0] as unknown[]
      )[0] as {
        extraLines?: unknown[];
        metadata: Record<string, string>;
      };
      expect(params.extraLines).toBeUndefined();
      expect(params.metadata.tseSurcharge).toBeUndefined();
      expect(t.event.tseSurcharge).toBeNull();
      expect(t.event.priceCharged).toBe(25);
    }
  });

  it('a waived event costs no surcharge', async () => {
    const t = setup('de-full', { surcharge: 4.5 });
    await t.unlock('waived');
    expect(t.event.tseIncluded).toBe(true);
    expect(t.event.tseSurcharge).toBeNull();
  });

  it('price preview carries the TSE terms (offer, surcharge, missing master data)', async () => {
    const t = setup('de-legacy-no', { surcharge: 4.5 });
    (t.org.settings as unknown as Record<string, unknown>).taxNumber = '';
    const preview = await t.billing.previewPrice(
      ORG,
      '2026-12-12',
      undefined,
      admin,
    );
    expect(preview.tse).toEqual({
      offer: 'optional',
      surcharge: 4.5,
      missing: ['taxNumber'],
      included: null,
      surchargeCharged: null,
    });
    const at = setup('at-full', { surcharge: 4.5 });
    expect(
      (await at.billing.previewPrice(ORG, '2026-12-12', undefined, admin)).tse,
    ).toMatchObject({ offer: null, surcharge: 0 });
  });
});

describe('Cloud-TSE after switching to „Alle Funktionen“', () => {
  it('enables the integration with a paid event (source operating_mode)', async () => {
    const t = setup('de-full');
    t.event.billingStatus = 'paid';
    const result = await t.tseAuto.onModeSwitchedToFull(ORG, admin.id);
    expect(result).toMatchObject({
      integrationEnabled: true,
      tseFollows: true,
      plan: { scheduledFor: '2026-12-11', eventName: 'Weihnachtsmarkt' },
    });
    expect(t.integration()).toMatchObject({
      enabled: true,
      auto: { source: 'operating_mode', eventId: EVENT_ID, path: null },
    });
    expect(t.audit[0]).toMatchObject({
      reason: 'automatisch beim Wechsel auf „Alle Funktionen“',
    });
  });

  it('does nothing without a paid event', async () => {
    const t = setup('de-full');
    const result = await t.tseAuto.onModeSwitchedToFull(ORG, admin.id);
    expect(result.tseFollows).toBe(false);
    expect(t.integration()).toBeNull();
  });
});

describe('helpers', () => {
  it('autoCreationDay: 12 h before the sales window, never before the event month or today', () => {
    const now = new Date('2026-11-03T10:00:00Z');
    const at = (start: string, end: string | null = null) =>
      autoCreationDay(
        { startDate: new Date(start), endDate: end ? new Date(end) : null },
        now,
      );
    // Fest 12.12. 16:00: Geschaeftstag ab 12.12. 6 Uhr, echt ab 11.12. 18 Uhr
    expect(at('2026-12-12T15:00:00Z')).toBe('2026-12-11');
    // 03:00 Berlin am 12.12. gehoert zum 11.12. → echt ab 10.12. 18 Uhr
    expect(at('2026-12-12T02:00:00Z')).toBe('2026-12-10');
    // reine Daten 16.–17.12. → am 15.12. (6 Uhr)
    expect(at('2026-12-15T23:00:00Z', '2026-12-16T23:00:00Z')).toBe(
      '2026-12-15',
    );
    // Fest am 1.12. (reine Daten): nicht im November, sondern am 1. um 0 Uhr
    expect(at('2026-11-30T23:00:00Z', '2026-11-30T23:00:00Z')).toBe(
      '2026-12-01',
    );
    expect(at('2026-11-01T15:00:00Z')).toBe('2026-11-03');
  });

  it('tseAutoEnabledInfo reads only automatic, still enabled entries', () => {
    const auto = {
      source: 'purchase',
      eventId: 'e',
      eventName: 'Fest',
      path: 'invoice',
      at: '2026-11-03T10:00:00.000Z',
    };
    expect(
      tseAutoEnabledInfo({ integrations: { tse: { enabled: true, auto } } }),
    ).toEqual(auto);
    expect(
      tseAutoEnabledInfo({ integrations: { tse: { enabled: false, auto } } }),
    ).toBeNull();
    expect(
      tseAutoEnabledInfo({ integrations: { tse: { enabled: true } } }),
    ).toBeNull();
  });
});
