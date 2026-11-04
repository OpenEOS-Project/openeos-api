import { BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';

import { ErrorCodes } from '../../common/constants/error-codes';
import { AdminAction } from '../../database/entities/admin-audit-log.entity';
import { Event } from '../../database/entities/event.entity';
import { Organization } from '../../database/entities/organization.entity';
import { User } from '../../database/entities';
import { TseAutoActivationService } from '../tse/tse-auto-activation.service';
import type { TseConfig } from '../tse/tse.config';
import type { TseNotifyService } from '../tse/tse-notify.service';
import type { TseUnitService } from '../tse/tse-unit.service';
import type { BillingAuditService } from './billing-audit.service';
import { EventBillingService } from './event-billing.service';
import type { EventUnlockCancellationService } from './event-unlock-cancellation.service';
import {
  isValidTaxNumber,
  isValidVatId,
  missingPurchaseMasterData,
  purchaseMasterDataOf,
} from './purchase-master-data';

beforeAll(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});

const ORG = '00000000-0000-4000-8000-0000000000a1';
const EVENT_ID = '00000000-0000-4000-8000-0000000000e1';
const admin = { id: 'user-1', email: 'admin@example.org' } as User;

/** Frisch registriert: nur Name und Land, keine Steuer- oder Rechnungsdaten. */
function freshOrg(
  overrides: Partial<Organization> & {
    settings?: Record<string, unknown>;
  } = {},
): Organization {
  return {
    id: ORG,
    name: 'MV Harmonie',
    country: 'DE',
    operatingMode: 'full',
    operatingModeLegacy: false,
    billingMode: 'prepaid',
    billingEmail: null,
    billingAddress: null,
    stripeCustomerId: null,
    eventPriceOverride: null,
    discountPercent: null,
    discountValidUntil: null,
    ...overrides,
    settings: {
      timezone: 'Europe/Berlin',
      currency: 'EUR',
      ...overrides.settings,
    },
  } as unknown as Organization;
}

const complete = {
  billingAddress: {
    name: 'Musikverein Harmonie e.V.',
    street: 'Hauptstr. 1',
    zip: '12345',
    city: 'Musterstadt',
    country: 'DE',
  },
  settings: {
    legalName: 'Musikverein Harmonie e.V.',
    taxNumber: '12/345/67890',
    contact: { address: 'Hauptstr. 1', zipCode: '12345', city: 'Musterstadt' },
  },
};

describe('purchase master data rules', () => {
  it('a freshly registered organization lacks name and billing address; tax only with Cloud-TSE', () => {
    const org = freshOrg();
    expect(missingPurchaseMasterData(org, { withTse: false })).toEqual([
      'legalName',
      'street',
      'zip',
      'city',
    ]);
    expect(missingPurchaseMasterData(org, { withTse: true })).toEqual([
      'legalName',
      'street',
      'zip',
      'city',
      'taxNumber',
    ]);
  });

  it('complete data passes; a valid USt-IdNr. alone is enough', () => {
    expect(
      missingPurchaseMasterData(freshOrg(complete), { withTse: true }),
    ).toEqual([]);
    const vatOnly = freshOrg({
      ...complete,
      settings: {
        ...complete.settings,
        taxNumber: '',
        vatId: 'de 123 456 789',
      },
    });
    expect(missingPurchaseMasterData(vatOnly, { withTse: true })).toEqual([]);
  });

  it('validates the German formats', () => {
    expect(isValidTaxNumber('12/345/67890')).toBe(true);
    expect(isValidTaxNumber('2181508150')).toBe(true);
    expect(isValidTaxNumber('9181081508155')).toBe(true);
    expect(isValidTaxNumber('123')).toBe(false);
    expect(isValidTaxNumber('12a/345/67890')).toBe(false);
    expect(isValidVatId('DE123456789')).toBe(true);
    expect(isValidVatId('DE12345678')).toBe(false);
    expect(isValidVatId('ATU12345678')).toBe(true);
    const badTax = freshOrg({
      ...complete,
      settings: { ...complete.settings, taxNumber: '123' },
    });
    expect(missingPurchaseMasterData(badTax, { withTse: true })).toEqual([
      'taxNumber',
    ]);
    const badVat = freshOrg({
      ...complete,
      settings: { ...complete.settings, vatId: 'DE1' },
    });
    expect(missingPurchaseMasterData(badVat, { withTse: true })).toEqual([
      'vatId',
    ]);
    // Ohne Cloud-TSE spielen Steuerangaben keine Rolle.
    expect(missingPurchaseMasterData(badVat, { withTse: false })).toEqual([]);
  });

  it('with Cloud-TSE the organization address (DSFinV-K) is required too', () => {
    const noContact = freshOrg({
      ...complete,
      settings: { legalName: 'X e.V.', taxNumber: '12/345/67890' },
    });
    expect(missingPurchaseMasterData(noContact, { withTse: false })).toEqual(
      [],
    );
    expect(missingPurchaseMasterData(noContact, { withTse: true })).toEqual([
      'street',
      'zip',
      'city',
    ]);
  });

  it('prefills from the billing recipient and the organization address', () => {
    const org = freshOrg({
      billingAddress: {
        name: 'Verein e.V.',
        street: '',
        zip: '',
        city: '',
        country: 'DE',
      },
      settings: {
        contact: { address: 'Weg 2', zipCode: '54321', city: 'Dorf' },
      },
    });
    expect(purchaseMasterDataOf(org)).toMatchObject({
      legalName: 'Verein e.V.',
      street: 'Weg 2',
      zip: '54321',
      city: 'Dorf',
    });
  });
});

function setup(org: Organization, options: { legacy?: boolean } = {}) {
  if (options.legacy) org.operatingModeLegacy = true;
  const event = {
    id: EVENT_ID,
    organizationId: ORG,
    name: 'Sommerfest',
    startDate: new Date('2026-12-12T15:00:00Z'),
    endDate: new Date('2026-12-12T23:00:00Z'),
    billingStatus: 'none',
    tseIncluded: null,
    tseSurcharge: null,
  } as unknown as Event;
  const configService = {
    get: (key: string, fallback?: unknown) =>
      ({ 'billing.eventPriceEur': 25 })[key] ?? fallback,
  } as unknown as ConfigService;
  const tseAuto = new TseAutoActivationService(
    {} as never,
    { enabled: true } as unknown as TseConfig,
    {} as unknown as TseUnitService,
    {} as unknown as TseNotifyService,
    configService,
  );
  const queryBuilder = {
    withDeleted: () => queryBuilder,
    where: () => queryBuilder,
    andWhere: () => queryBuilder,
    getCount: () => Promise.resolve(1),
  };
  const organizationRepository = {
    findOne: jest.fn(() => Promise.resolve(org)),
    save: jest.fn((o: Organization) => Promise.resolve(o)),
  };
  const stripe = {
    isConfigured: true,
    ensureCustomer: jest.fn().mockResolvedValue('cus_1'),
    createCheckoutSession: jest
      .fn()
      .mockResolvedValue({ id: 'cs_1', url: 'https://stripe.test/cs_1' }),
  };
  const audit = { record: jest.fn() };
  const billing = new EventBillingService(
    {
      findOne: jest.fn(() => Promise.resolve(event)),
      save: jest.fn((e: Event) => Promise.resolve(e)),
      createQueryBuilder: () => queryBuilder,
    } as unknown as Repository<Event>,
    organizationRepository as unknown as Repository<Organization>,
    { checkPermission: jest.fn(), checkRole: jest.fn() } as never,
    {} as never,
    {} as never,
    stripe as never,
    configService,
    {} as unknown as EventUnlockCancellationService,
    audit as unknown as BillingAuditService,
    { isAvailable: false } as never,
    tseAuto,
  );
  return { billing, stripe, organizationRepository, audit, event };
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return (error as BadRequestException).getResponse() as {
      code: string;
      params?: Record<string, unknown>;
    };
  }
  throw new Error('expected an error');
}

describe('EventBillingService — required data at purchase', () => {
  it('checkout: 400 PURCHASE_MASTER_DATA_REQUIRED with the missing fields, no Stripe call', async () => {
    const f = setup(freshOrg());
    const response = await errorOf(
      f.billing.createStripeCheckout(ORG, EVENT_ID, admin),
    );
    expect(response).toMatchObject({
      code: ErrorCodes.PURCHASE_MASTER_DATA_REQUIRED,
      params: { missing: 'legalName,street,zip,city,taxNumber', withTse: true },
    });
    expect(f.stripe.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('checkout: legacy without Cloud-TSE needs no tax data; with „Ja“ it does', async () => {
    const org = freshOrg({
      billingAddress: complete.billingAddress,
      settings: { legalName: 'MV e.V.' },
    });
    const f = setup(org, { legacy: true });
    await expect(
      f.billing.createStripeCheckout(ORG, EVENT_ID, admin, { withTse: false }),
    ).resolves.toEqual({ checkoutUrl: 'https://stripe.test/cs_1' });
    const response = await errorOf(
      f.billing.createStripeCheckout(ORG, EVENT_ID, admin, { withTse: true }),
    );
    expect(response.params?.missing).toBe('street,zip,city,taxNumber');
  });

  it('checkout with complete data passes the legal name and address to Stripe', async () => {
    const f = setup(freshOrg(complete));
    await f.billing.createStripeCheckout(ORG, EVENT_ID, admin);
    expect(f.stripe.ensureCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationName: 'Musikverein Harmonie e.V.',
        address: expect.objectContaining({
          line1: 'Hauptstr. 1',
          city: 'Musterstadt',
        }) as unknown,
      }),
    );
  });

  it('invoice: the address from the form counts, the tax number does not come from it', async () => {
    const org = freshOrg({ billingMode: 'invoice' } as Partial<Organization>);
    const f = setup(org);
    const response = await errorOf(
      f.billing.orderInvoice(
        ORG,
        EVENT_ID,
        {
          billingName: 'MV Harmonie e.V.',
          billingEmail: 'kasse@example.org',
          billingAddress: {
            street: 'Hauptstr. 1',
            zip: '12345',
            city: 'Musterstadt',
          },
        },
        admin,
      ),
    );
    // Name und Rechnungsanschrift kamen aus dem Formular; fuer die TSE
    // fehlen Steuernummer und die Anschrift der Organisation.
    expect(response.params?.missing).toBe('street,zip,city,taxNumber');
    // Nichts gespeichert.
    expect(f.organizationRepository.save).not.toHaveBeenCalled();
  });

  it('save: validates DE formats, writes settings, billing address and an empty contact address', async () => {
    const org = freshOrg();
    const f = setup(org);
    const bad = await errorOf(
      f.billing.savePurchaseMasterData(
        ORG,
        {
          legalName: 'MV Harmonie e.V.',
          street: 'Hauptstr. 1',
          zip: '12345',
          city: 'Musterstadt',
          taxNumber: '123',
        },
        admin,
      ),
    );
    expect(bad).toMatchObject({
      code: ErrorCodes.TAX_ID_INVALID,
      params: { field: 'taxNumber' },
    });

    const status = await f.billing.savePurchaseMasterData(
      ORG,
      {
        legalName: ' MV Harmonie e.V. ',
        street: 'Hauptstr. 1',
        zip: '12345',
        city: 'Musterstadt',
        vatId: 'de 123456789',
      },
      admin,
    );
    expect(status.missingWithTse).toEqual([]);
    expect(org.settings).toMatchObject({
      legalName: 'MV Harmonie e.V.',
      vatId: 'DE123456789',
      contact: {
        address: 'Hauptstr. 1',
        zipCode: '12345',
        city: 'Musterstadt',
      },
      timezone: 'Europe/Berlin',
    });
    expect(org.billingAddress).toEqual({
      name: 'MV Harmonie e.V.',
      street: 'Hauptstr. 1',
      zip: '12345',
      city: 'Musterstadt',
      country: 'DE',
    });
    await expect(
      f.billing.createStripeCheckout(ORG, EVENT_ID, admin),
    ).resolves.toBeDefined();
  });

  it('save keeps an existing organization address', async () => {
    const org = freshOrg({
      settings: {
        contact: { address: 'Vereinsheim 1', zipCode: '11111', city: 'A' },
      },
    });
    const f = setup(org);
    await f.billing.savePurchaseMasterData(
      ORG,
      { legalName: 'X e.V.', street: 'Kassenwart 2', zip: '22222', city: 'B' },
      admin,
    );
    expect((org.settings as unknown as { contact: unknown }).contact).toEqual({
      address: 'Vereinsheim 1',
      zipCode: '11111',
      city: 'A',
    });
    expect(org.billingAddress?.street).toBe('Kassenwart 2');
  });

  it('waiver: 400 without data, 400 with override but no reason, audited override with reason', async () => {
    const f = setup(freshOrg());
    const actor = { userId: 'root', ipAddress: '127.0.0.1' };
    expect(
      (await errorOf(f.billing.assertWaiveMasterData(EVENT_ID, {}, actor)))
        .code,
    ).toBe(ErrorCodes.PURCHASE_MASTER_DATA_REQUIRED);
    expect(
      (
        await errorOf(
          f.billing.assertWaiveMasterData(
            EVENT_ID,
            { overrideMasterData: true, overrideReason: '  ' },
            actor,
          ),
        )
      ).code,
    ).toBe(ErrorCodes.PURCHASE_MASTER_DATA_OVERRIDE_REASON_REQUIRED);
    await f.billing.assertWaiveMasterData(
      EVENT_ID,
      { overrideMasterData: true, overrideReason: 'Angaben kommen per Mail' },
      actor,
    );
    expect(f.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AdminAction.EVENT_MASTER_DATA_OVERRIDE,
        reason: 'Angaben kommen per Mail',
        details: expect.objectContaining({ withTse: true }) as unknown,
      }),
    );
  });

  it('billing info exposes the master data status for the dialog', () => {
    const f = setup(freshOrg(), { legacy: true });
    const status = f.billing.masterDataStatus(
      freshOrg({ operatingModeLegacy: true } as Partial<Organization>),
    );
    expect(status.missing).toEqual(['legalName', 'street', 'zip', 'city']);
    expect(status.missingWithTse).toContain('taxNumber');
    expect(f).toBeDefined();
  });
});
