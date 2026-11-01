import { ForbiddenException } from '@nestjs/common';
import { PaymentMethod } from '../../database/entities/payment.entity';
import {
  assertCashAllowed,
  cashPolicyReason,
  cashPolicyView,
  hasActiveTse,
  isCashBlocked,
  keepCountryMirror,
  resolveCashPolicy,
  tseHook,
  type CashPolicyOrg,
} from './cash-policy.util';
import { assertPaymentsAllowed } from './operating-mode.util';
import { normalizeCountry, COUNTRY_CODES } from '../constants/countries';

function code(call: () => void): string | null {
  try {
    call();
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(ForbiddenException);
    return ((e as ForbiddenException).getResponse() as { code: string }).code;
  }
}

/**
 * Wie die Kasse prueft: erst „Nur Bestellen“ (keine Zahlung), dann die
 * Bargeld-Regel bzw. der bargeldlose Schalter.
 */
function cashOutcome(org: CashPolicyOrg): string {
  return (
    code(() => {
      assertPaymentsAllowed(org.settings);
      assertCashAllowed(org, PaymentMethod.CASH);
    }) ?? 'ok'
  );
}

const cases: [
  string,
  CashPolicyOrg,
  ReturnType<typeof resolveCashPolicy>,
  string,
  string,
][] = [
  // name, org, policy, reason, outcome for a cash payment
  [
    'DE, new organization',
    { country: 'DE', cashPolicyLegacy: false, settings: {} },
    'blocked_de_no_tse',
    'de_no_tse',
    'CASH_NOT_ALLOWED_IN_COUNTRY',
  ],
  [
    'DE, legacy organization',
    { country: 'DE', cashPolicyLegacy: true, settings: {} },
    'allowed',
    'legacy',
    'ok',
  ],
  [
    'DE, legacy with its own cashless switch on',
    {
      country: 'DE',
      cashPolicyLegacy: true,
      settings: { payments: { cashless: true } },
    },
    'allowed',
    'legacy',
    'CASH_PAYMENTS_DISABLED',
  ],
  [
    'DE, legacy organization that switched voluntarily',
    { country: 'DE', cashPolicyLegacy: false, settings: {} },
    'blocked_de_no_tse',
    'de_no_tse',
    'CASH_NOT_ALLOWED_IN_COUNTRY',
  ],
  [
    'DE, new organization with a stale cashless switch (policy wins)',
    {
      country: 'DE',
      cashPolicyLegacy: false,
      settings: { payments: { cashless: false } },
    },
    'blocked_de_no_tse',
    'de_no_tse',
    'CASH_NOT_ALLOWED_IN_COUNTRY',
  ],
  [
    'AT',
    { country: 'AT', cashPolicyLegacy: false, settings: {} },
    'allowed',
    'country',
    'ok',
  ],
  [
    'AT with the cashless switch on',
    {
      country: 'AT',
      cashPolicyLegacy: false,
      settings: { payments: { cashless: true } },
    },
    'allowed',
    'country',
    'CASH_PAYMENTS_DISABLED',
  ],
  [
    'CH',
    { country: 'CH', cashPolicyLegacy: false, settings: {} },
    'allowed',
    'country',
    'ok',
  ],
  [
    'other country (IT)',
    { country: 'IT', cashPolicyLegacy: false, settings: {} },
    'allowed',
    'country',
    'ok',
  ],
  [
    'legacy without country',
    { country: null, cashPolicyLegacy: true, settings: {} },
    'allowed',
    'legacy',
    'ok',
  ],
  [
    'no country, not legacy',
    { country: null, cashPolicyLegacy: false, settings: {} },
    'allowed',
    'no_country',
    'ok',
  ],
  [
    'order-only mode in DE (order-only wins)',
    {
      country: 'DE',
      cashPolicyLegacy: false,
      settings: { operatingMode: 'order_only' },
    },
    'blocked_de_no_tse',
    'de_no_tse',
    'ORDER_ONLY_MODE',
  ],
  [
    'order-only mode for a legacy org',
    {
      country: 'AT',
      cashPolicyLegacy: true,
      settings: { operatingMode: 'order_only' },
    },
    'allowed',
    'legacy',
    'ORDER_ONLY_MODE',
  ],
];

describe('resolveCashPolicy — policy matrix', () => {
  it.each(cases)('%s', (_name, org, policy, reason, outcome) => {
    expect(resolveCashPolicy(org)).toBe(policy);
    expect(cashPolicyReason(org)).toBe(reason);
    expect(cashOutcome(org)).toBe(outcome);
  });

  it('treats lower-case country codes like upper-case ones', () => {
    expect(resolveCashPolicy({ country: 'de', cashPolicyLegacy: false })).toBe(
      'blocked_de_no_tse',
    );
  });

  it('has no active TSE today', () => {
    expect(hasActiveTse({ country: 'DE' })).toBe(false);
  });

  describe('with an active TSE (future flag)', () => {
    const original = tseHook.isActive;
    afterEach(() => {
      tseHook.isActive = original;
    });

    it('lets new German organizations take cash again automatically', () => {
      tseHook.isActive = () => true;
      const org = { country: 'DE', cashPolicyLegacy: false, settings: {} };
      expect(resolveCashPolicy(org)).toBe('allowed');
      expect(cashPolicyReason(org)).toBe('de_tse');
      expect(cashOutcome(org)).toBe('ok');
    });
  });
});

describe('assertCashAllowed', () => {
  const blocked = { country: 'DE', cashPolicyLegacy: false, settings: {} };

  it.each([
    PaymentMethod.CARD,
    PaymentMethod.SUMUP_TERMINAL,
    PaymentMethod.SUMUP_ONLINE,
    PaymentMethod.PAYPAL,
  ])('lets %s through for "Germany without cash"', (method) => {
    expect(() => assertCashAllowed(blocked, method)).not.toThrow();
  });

  it('rejects cash-only operations (drawer, Pfand payout) without a method', () => {
    expect(code(() => assertCashAllowed(blocked))).toBe(
      'CASH_NOT_ALLOWED_IN_COUNTRY',
    );
  });

  it('isCashBlocked covers both the policy and the switch', () => {
    expect(isCashBlocked(blocked)).toBe(true);
    expect(
      isCashBlocked({
        country: 'AT',
        settings: { payments: { cashless: true } },
      }),
    ).toBe(true);
    expect(isCashBlocked({ country: 'AT', settings: {} })).toBe(false);
  });
});

describe('cashPolicyView', () => {
  it('returns the fields for GET /organizations/:id', () => {
    expect(
      cashPolicyView({ country: 'DE', cashPolicyLegacy: true, settings: {} }),
    ).toEqual({
      country: 'DE',
      cashPolicy: 'allowed',
      cashPolicyLegacy: true,
      cashPolicyReason: 'legacy',
    });
  });
});

describe('keepCountryMirror', () => {
  it('overwrites settings.address.country with the column', () => {
    const incoming = { address: { street: 'Weg 1', country: 'AT' } };
    keepCountryMirror(incoming, 'DE');
    expect(incoming.address.country).toBe('DE');
  });

  it('drops it while no country is set', () => {
    const incoming: { address: { country?: string } } = {
      address: { country: 'AT' },
    };
    keepCountryMirror(incoming, null);
    expect(incoming.address).toEqual({});
  });
});

describe('countries', () => {
  it('knows all 249 ISO 3166-1 alpha-2 codes, DACH included', () => {
    expect(COUNTRY_CODES).toHaveLength(249);
    for (const c of ['DE', 'AT', 'CH', 'IT', 'FR', 'PL', 'CZ']) {
      expect(normalizeCountry(c)).toBe(c);
    }
    expect(normalizeCountry(' at ')).toBe('AT');
    expect(normalizeCountry('XX')).toBeNull();
    expect(normalizeCountry('Deutschland')).toBeNull();
  });
});
