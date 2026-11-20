import { ForbiddenException } from '@nestjs/common';
import {
  PaymentMethod,
  PaymentProvider,
} from '../../database/entities/payment.entity';
import { ErrorCodes, ErrorReasons } from '../constants/error-codes';

/**
 * Testzahlungen (Entscheidung 2026-11-19): Solange eine Bestellung eine
 * Testbestellung ist (`orders.is_test` — Veranstaltung im Testmodus oder
 * „Geplant“), bietet die Kasse „Bar (Test)“ und „Karte (Test)“ an. So laesst
 * sich der Kassenablauf in jeder Betriebsart ausser „Nur Bons“ durchspielen
 * — auch in Deutschland ohne TSE und ohne SumUp.
 *
 * Es sind Simulationen, kein Bargeld: Trainingsbuchungen mit echtem
 * Bargeld muessten in Deutschland TSE-gesichert sein (KassenSichV), eine
 * Barfunktion ohne TSE gibt es deshalb nicht. Eine Testzahlung
 * - wird nur fuer Testbestellungen angenommen (403 sonst),
 * - oeffnet keine Kassenlade, steht nicht im Kassenbuch, nicht im
 *   DSFinV-K-Export und wird nicht ueber die TSE signiert,
 * - zaehlt in der Kellnerabrechnung nur als „Training (nicht im Geld)“,
 * - wird nur auf die Testzahlung selbst „erstattet“ (Status `test`),
 * - verschwindet beim Aktivieren mit den Testbestellungen (CASCADE).
 *
 * Echtes Bargeld (`cash`) laeuft unveraendert ueber `assertCashAllowed`.
 */
export const TEST_PAYMENT_METHODS: readonly string[] = [
  PaymentMethod.TEST_CASH,
  PaymentMethod.TEST_CARD,
];

export function isTestPaymentMethod(
  method: PaymentMethod | string | null | undefined,
): boolean {
  return typeof method === 'string' && TEST_PAYMENT_METHODS.includes(method);
}

export function testPaymentRequiresTestOrderError(
  orderIds: string[] = [],
): ForbiddenException {
  return new ForbiddenException({
    code: ErrorCodes.FORBIDDEN,
    reason: ErrorReasons.TEST_PAYMENT_REQUIRES_TEST_ORDER,
    message:
      'Testzahlungen („Bar (Test)“, „Karte (Test)“) gehen nur für Testbestellungen im Testmodus. Kassiere echte Bestellungen mit einer echten Zahlart.',
    params: { orderIds },
  });
}

/**
 * 403, wenn eine Testzahlung auf eine Bestellung soll, die keine
 * Testbestellung ist. Andere Zahlarten: nichts zu pruefen. Die Betriebsart
 * („Nur Bons“) prueft `assertPaymentsAllowed` davor.
 */
export function assertTestPaymentAllowed(
  method: PaymentMethod | string | null | undefined,
  orders: readonly { id?: string; isTest?: boolean | null }[],
): void {
  if (!isTestPaymentMethod(method)) return;
  const real = orders.filter((o) => o.isTest !== true);
  if (orders.length === 0 || real.length > 0) {
    throw testPaymentRequiresTestOrderError(
      real.map((o) => o.id ?? '').filter(Boolean),
    );
  }
}

/** Anbieter einer Testzahlung. */
export const TEST_PAYMENT_PROVIDER = PaymentProvider.TEST;
