import { ForbiddenException } from '@nestjs/common';
import { PaymentMethod } from '../../database/entities/payment.entity';
import { isCashlessMode } from './cashless-mode.util';
import { assertCashAllowed } from './cash-policy.util';

const cashlessSettings = { payments: { cashless: true } };
// Bestandsorganisation: nur der Schalter des Vereins zaehlt.
const cashless = { settings: cashlessSettings, cashPolicyLegacy: true };

describe('cashless mode helper', () => {
  it('is off unless settings.payments.cashless is exactly true', () => {
    expect(isCashlessMode(undefined)).toBe(false);
    expect(isCashlessMode({})).toBe(false);
    expect(isCashlessMode({ payments: {} })).toBe(false);
    expect(isCashlessMode({ payments: { cashless: 'true' } })).toBe(false);
    expect(isCashlessMode({ payments: { cashless: false } })).toBe(false);
    expect(isCashlessMode(cashlessSettings)).toBe(true);
  });

  it('rejects cash (and cash-only operations) with 403 CASH_PAYMENTS_DISABLED', () => {
    for (const method of [PaymentMethod.CASH, 'cash', undefined]) {
      let error: unknown;
      try {
        assertCashAllowed(cashless, method);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'CASH_PAYMENTS_DISABLED',
      });
    }
  });

  it.each([
    PaymentMethod.CARD,
    PaymentMethod.SUMUP_TERMINAL,
    PaymentMethod.SUMUP_ONLINE,
    PaymentMethod.PAYPAL,
    PaymentMethod.GOOGLE_PAY,
    PaymentMethod.APPLE_PAY,
  ])('lets %s through in cashless mode', (method) => {
    expect(() => assertCashAllowed(cashless, method)).not.toThrow();
  });

  it('allows cash when the mode is off (default)', () => {
    expect(() =>
      assertCashAllowed({ settings: {} }, PaymentMethod.CASH),
    ).not.toThrow();
    expect(() => assertCashAllowed(null)).not.toThrow();
  });
});
