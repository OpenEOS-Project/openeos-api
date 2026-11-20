import { ForbiddenException } from '@nestjs/common';
import { PaymentMethod } from '../../database/entities/payment.entity';
import {
  TEST_PAYMENT_METHODS,
  assertTestPaymentAllowed,
  isTestPaymentMethod,
} from './test-payment.util';
import { isCashlessPaymentMethod } from './operating-mode.util';

function reasonOf(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(ForbiddenException);
    return ((e as ForbiddenException).getResponse() as { reason: string })
      .reason;
  }
}

describe('test payments', () => {
  it('knows the two simulated methods and nothing else', () => {
    expect(TEST_PAYMENT_METHODS).toEqual(['test_cash', 'test_card']);
    expect(isTestPaymentMethod(PaymentMethod.TEST_CASH)).toBe(true);
    expect(isTestPaymentMethod(PaymentMethod.TEST_CARD)).toBe(true);
    for (const method of [
      PaymentMethod.CASH,
      PaymentMethod.CARD,
      PaymentMethod.SUMUP_TERMINAL,
      PaymentMethod.TOKENS,
      null,
      undefined,
    ]) {
      expect(isTestPaymentMethod(method)).toBe(false);
    }
    // Nicht auf der Positivliste fuer „Bargeldlos“: kein echtes unbares Geld.
    expect(isCashlessPaymentMethod(PaymentMethod.TEST_CARD)).toBe(false);
  });

  it('accepts a test payment only when every order is a test order', () => {
    const test = { id: 'o-1', isTest: true };
    const real = { id: 'o-2', isTest: false };
    expect(
      reasonOf(() => assertTestPaymentAllowed(PaymentMethod.TEST_CASH, [test])),
    ).toBeNull();
    expect(
      reasonOf(() =>
        assertTestPaymentAllowed(PaymentMethod.TEST_CARD, [test, test]),
      ),
    ).toBeNull();
    expect(
      reasonOf(() => assertTestPaymentAllowed(PaymentMethod.TEST_CASH, [real])),
    ).toBe('TEST_PAYMENT_REQUIRES_TEST_ORDER');
    expect(
      reasonOf(() =>
        assertTestPaymentAllowed(PaymentMethod.TEST_CARD, [test, real]),
      ),
    ).toBe('TEST_PAYMENT_REQUIRES_TEST_ORDER');
    expect(
      reasonOf(() => assertTestPaymentAllowed(PaymentMethod.TEST_CASH, [{}])),
    ).toBe('TEST_PAYMENT_REQUIRES_TEST_ORDER');
    expect(
      reasonOf(() => assertTestPaymentAllowed(PaymentMethod.TEST_CASH, [])),
    ).toBe('TEST_PAYMENT_REQUIRES_TEST_ORDER');
  });

  it('leaves real payment methods alone (cash is checked by assertCashAllowed)', () => {
    const real = { id: 'o-2', isTest: false };
    for (const method of [PaymentMethod.CASH, PaymentMethod.CARD]) {
      expect(
        reasonOf(() => assertTestPaymentAllowed(method, [real])),
      ).toBeNull();
    }
  });
});
