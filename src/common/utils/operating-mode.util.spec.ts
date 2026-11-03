import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OrderItemStatus } from '../../database/entities/order-item.entity';
import { PaymentMethod } from '../../database/entities/payment.entity';
import {
  OPERATING_MODES,
  assertCashAllowed,
  assertOrderOnlyCompletable,
  assertPaymentsAllowed,
  arePricesVisible,
  getOperatingMode,
  handOverOnCompletion,
  initialOperatingMode,
  isCashAllowed,
  isCertificateAvailable,
  isOnlinePrepaymentMethod,
  itemsStillInProduction,
  keepCountryMirror,
  modeUnavailableReason,
  operatingModeView,
  shouldAutoCompleteOrderOnly,
  stripModeSettings,
  type OperatingMode,
} from './operating-mode.util';
import { hasActiveTse, tseStatus } from './tse.util';

const item = (
  status: OrderItemStatus,
  productionStationId: string | null = null,
) => ({ status, productionStationId, productName: 'Pommes' });

function codeOf(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(ForbiddenException);
    return ((e as ForbiddenException).getResponse() as { code: string }).code;
  }
}

afterEach(() => {
  tseStatus.isActive = () => false;
});

/*
 * Matrix der Betriebsarten (betriebsarten-spec.md): Land × Betriebsart ×
 * Bestand × TSE. Erwartet: Bargeld, Zahlungen, Preise, Fehlercode einer
 * Barzahlung und waehlbare Betriebsarten.
 */
const COUNTRIES = ['DE', 'AT', 'CH', 'FR'] as const;
type Case = {
  country: (typeof COUNTRIES)[number];
  mode: OperatingMode;
  legacy: boolean;
  tse: boolean;
};
const cases: Case[] = [];
for (const country of COUNTRIES)
  for (const mode of OPERATING_MODES)
    for (const legacy of [false, true])
      for (const tse of [false, true])
        cases.push({ country, mode, legacy, tse });

function expected(c: Case) {
  const cash = c.mode === 'full' && (c.country !== 'DE' || c.legacy || c.tse);
  const cashError =
    c.mode === 'orders_only'
      ? 'ORDER_ONLY_MODE'
      : c.mode === 'cashless'
        ? 'CASH_PAYMENTS_DISABLED'
        : cash
          ? null
          : 'TSE_REQUIRED_FOR_CASH';
  return {
    cash,
    cashError,
    payments: c.mode !== 'orders_only',
    prices: c.mode !== 'orders_only',
    fullSelectable: c.country !== 'DE' || c.tse,
    certificate: c.country === 'DE' && c.mode !== 'full',
  };
}

describe('operating mode matrix (country × mode × legacy × TSE)', () => {
  it.each(cases)('%o', (c) => {
    tseStatus.isActive = () => c.tse;
    const org = {
      id: 'org-1',
      country: c.country,
      operatingMode: c.mode,
      operatingModeLegacy: c.legacy,
    };
    const want = expected(c);

    expect(hasActiveTse(org)).toBe(c.tse);
    expect(isCashAllowed(org)).toBe(want.cash);
    expect(arePricesVisible(org)).toBe(want.prices);
    expect(codeOf(() => assertCashAllowed(org, PaymentMethod.CASH))).toBe(
      want.cashError,
    );
    // Reiner Bargeldvorgang (Kassenlade, Pfand-Auszahlung) wie Barzahlung.
    expect(codeOf(() => assertCashAllowed(org))).toBe(want.cashError);
    // Karte: nur in orders_only gesperrt (dort per assertPaymentsAllowed).
    expect(codeOf(() => assertCashAllowed(org, PaymentMethod.CARD))).toBeNull();
    expect(codeOf(() => assertPaymentsAllowed(org))).toBe(
      want.payments ? null : 'ORDER_ONLY_MODE',
    );
    expect(modeUnavailableReason(org, 'orders_only')).toBeNull();
    expect(modeUnavailableReason(org, 'cashless')).toBeNull();
    expect(modeUnavailableReason(org, 'full')).toBe(
      want.fullSelectable ? null : 'tse_required',
    );
    expect(isCertificateAvailable(org)).toBe(want.certificate);
    expect(operatingModeView(org)).toMatchObject({
      country: c.country,
      operatingMode: c.mode,
      operatingModeLegacy: c.legacy,
      tseActive: c.tse,
      cashAllowed: want.cash,
      pricesVisible: want.prices,
    });
  });
});

describe('operating mode helper', () => {
  it('unknown or missing values count as full (legacy organizations)', () => {
    expect(getOperatingMode(undefined)).toBe('full');
    expect(getOperatingMode({})).toBe('full');
    expect(getOperatingMode({ operatingMode: 'order_only' })).toBe('full');
    expect(getOperatingMode({ operatingMode: 'ORDERS_ONLY' })).toBe('full');
    expect(getOperatingMode({ operatingMode: 'orders_only' })).toBe(
      'orders_only',
    );
  });

  it('DE full without TSE: selectable when the Cloud-TSE follows a paid event', () => {
    const org = { id: 'org-1', country: 'DE', operatingMode: 'cashless' };
    expect(modeUnavailableReason(org, 'full')).toBe('tse_required');
    expect(modeUnavailableReason(org, 'full', { available: true })).toBe(
      'paid_event_required',
    );
    expect(
      modeUnavailableReason(org, 'full', { available: true, follows: true }),
    ).toBeNull();
    // Gewaehlt, aber ohne aktive TSE: noch kein Bargeld.
    expect(
      isCashAllowed({
        ...org,
        operatingMode: 'full',
        operatingModeLegacy: false,
      }),
    ).toBe(false);
  });

  it('without a country no mode can be chosen, cash follows the mode', () => {
    const org = { operatingMode: 'full', operatingModeLegacy: true };
    expect(modeUnavailableReason(org, 'cashless')).toBe('country_required');
    expect(modeUnavailableReason(org, 'full')).toBe('country_required');
    expect(isCashAllowed(org)).toBe(true);
    expect(isCashAllowed({ operatingMode: 'cashless' })).toBe(false);
  });

  it('the TSE stub is false by default and needs an organization', () => {
    expect(hasActiveTse({ id: 'org-1', country: 'DE' })).toBe(false);
    tseStatus.isActive = () => true;
    expect(hasActiveTse(null)).toBe(false);
    expect(hasActiveTse({ id: 'org-1' })).toBe(true);
  });

  it('new organizations: DE starts cashless, others full, self-hosted full with legacy', () => {
    expect(initialOperatingMode('DE', false)).toMatchObject({
      operatingMode: 'cashless',
      operatingModeLegacy: false,
    });
    expect(initialOperatingMode('de', false).operatingMode).toBe('cashless');
    for (const country of ['AT', 'CH', 'FR', null]) {
      expect(initialOperatingMode(country, false)).toMatchObject({
        operatingMode: 'full',
        operatingModeLegacy: false,
      });
    }
    expect(initialOperatingMode('DE', true)).toMatchObject({
      operatingMode: 'full',
      operatingModeLegacy: true,
    });
  });

  it('cash errors say what to do', () => {
    let error: unknown;
    try {
      assertCashAllowed(
        { country: 'DE', operatingMode: 'full', operatingModeLegacy: false },
        PaymentMethod.CASH,
      );
    } catch (e) {
      error = e;
    }
    expect((error as ForbiddenException).getStatus()).toBe(403);
    const response = (error as ForbiddenException).getResponse() as {
      code: string;
      message: string;
    };
    expect(response.code).toBe('TSE_REQUIRED_FOR_CASH');
    expect(response.message).toContain('Cloud-TSE');
  });

  it('only PayPal and SumUp Online count as online prepayment', () => {
    expect(isOnlinePrepaymentMethod(PaymentMethod.PAYPAL)).toBe(true);
    expect(isOnlinePrepaymentMethod(PaymentMethod.SUMUP_ONLINE)).toBe(true);
    for (const m of [
      PaymentMethod.CASH,
      PaymentMethod.CARD,
      PaymentMethod.SUMUP_TERMINAL,
      null,
    ]) {
      expect(isOnlinePrepaymentMethod(m)).toBe(false);
    }
  });

  it('strips the interim mode fields from incoming settings', () => {
    const settings = {
      vatExempt: true,
      operatingMode: 'order_only',
      operatingModeSince: 'x',
      payments: { cashless: true, changedAt: 'y' },
    };
    expect(stripModeSettings(settings)).toEqual({ vatExempt: true });
    expect(
      stripModeSettings({ payments: { cashless: false, other: 1 } }),
    ).toEqual({ payments: { other: 1 } });
    expect(stripModeSettings(undefined)).toBeUndefined();
  });

  it('keeps settings.address.country a copy of the column', () => {
    const incoming = { address: { city: 'Wien', country: 'DE' } };
    keepCountryMirror(incoming, 'AT');
    expect(incoming.address.country).toBe('AT');
    keepCountryMirror(incoming, null);
    expect(incoming.address).toEqual({ city: 'Wien' });
  });
});

describe('closing orders without payment', () => {
  it('counter orders complete once nothing is left at a station', () => {
    expect(
      shouldAutoCompleteOrderOnly('counter_pickup', [
        item(OrderItemStatus.PENDING),
      ]),
    ).toBe(true);
    expect(
      shouldAutoCompleteOrderOnly('takeaway', [
        item(OrderItemStatus.PENDING),
        item(OrderItemStatus.DELIVERED, 's1'),
        item(OrderItemStatus.CANCELLED, 's1'),
      ]),
    ).toBe(true);
    expect(
      shouldAutoCompleteOrderOnly('counter_pickup', [
        item(OrderItemStatus.READY, 's1'),
      ]),
    ).toBe(false);
    expect(
      shouldAutoCompleteOrderOnly('counter_pickup', [
        item(OrderItemStatus.CANCELLED),
      ]),
    ).toBe(false);
  });

  it('table orders never complete by themselves', () => {
    expect(
      shouldAutoCompleteOrderOnly('table_service', [
        item(OrderItemStatus.DELIVERED, 's1'),
      ]),
    ).toBe(false);
  });

  it('cannot be closed while a station is still working', () => {
    const items = [
      item(OrderItemStatus.READY, 's1'),
      item(OrderItemStatus.PREPARING, 's1'),
      item(OrderItemStatus.PENDING),
    ];
    expect(itemsStillInProduction(items)).toHaveLength(1);
    let error: unknown;
    try {
      assertOrderOnlyCompletable(items);
    } catch (e) {
      error = e;
    }
    expect((error as BadRequestException).getResponse()).toMatchObject({
      reason: 'ORDER_ITEMS_IN_PRODUCTION',
    });
    expect(() =>
      assertOrderOnlyCompletable([item(OrderItemStatus.READY, 's1')]),
    ).not.toThrow();
  });

  it('on completion everything not at a station any more counts as handed over', () => {
    const now = new Date('2026-11-01T12:00:00Z');
    const items = [
      { ...item(OrderItemStatus.PENDING), deliveredAt: null }, // Getraenk ohne Station
      { ...item(OrderItemStatus.READY), deliveredAt: null },
      { ...item(OrderItemStatus.READY, 's1'), deliveredAt: null },
      { ...item(OrderItemStatus.PREPARING, 's1'), deliveredAt: null },
      { ...item(OrderItemStatus.DELIVERED, 's1'), deliveredAt: null },
      { ...item(OrderItemStatus.CANCELLED), deliveredAt: null },
    ];
    const changed = handOverOnCompletion(items, now);
    expect(changed).toHaveLength(3);
    expect(items.map((i) => i.status)).toEqual([
      OrderItemStatus.DELIVERED,
      OrderItemStatus.DELIVERED,
      OrderItemStatus.DELIVERED,
      OrderItemStatus.PREPARING,
      OrderItemStatus.DELIVERED,
      OrderItemStatus.CANCELLED,
    ]);
    expect(changed.every((i) => i.deliveredAt === now)).toBe(true);
    expect(items[4].deliveredAt).toBeNull();
  });
});
