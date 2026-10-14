import { ForbiddenException } from '@nestjs/common';
import { PaymentMethod } from '../../database/entities/payment.entity';
import { ErrorCodes } from '../constants/error-codes';

/**
 * Bargeldloser Modus der Organisation (`settings.payments.cashless`).
 *
 * Hintergrund: Eine elektronische Kasse braucht eine zertifizierte TSE nur,
 * wenn sie Bargeld erfassen kann (AEAO zu § 146a AO). Ein Verein ohne TSE
 * kann OpenEOS deshalb rein bargeldlos betreiben — dann muss der Ausschluss
 * aber technisch durchgesetzt sein, nicht nur in der Oberflaeche. Jeder
 * Einstieg, der Bargeld bucht oder auszahlt, ruft deshalb
 * `assertCashAllowed` auf: Zahlung mit Bestellung, Einzel-, Teil- und
 * Sammelzahlung (Kasse und Verwaltung), Erstattung auf eine Barzahlung,
 * Pfand-Auszahlung und die Kassenlade.
 *
 * Nur ein ausdrueckliches `true` zaehlt; ohne Eintrag bleibt alles wie
 * bisher (Bargeld erlaubt).
 */
export function isCashlessMode(settings: object | null | undefined): boolean {
  const payments = (settings as { payments?: unknown } | null)?.payments;
  if (!payments || typeof payments !== 'object') return false;
  return (payments as { cashless?: unknown }).cashless === true;
}

/**
 * Weist Bargeld im bargeldlosen Modus mit 403 `CASH_PAYMENTS_DISABLED` ab.
 *
 * Mit Zahlart: nur `cash` wird abgewiesen, Karte, SumUp und Online-Zahlung
 * laufen weiter (auch mit Trinkgeld, geteilt oder gesammelt). Ohne Zahlart
 * (`undefined`) ist der Vorgang selbst ein reiner Bargeldvorgang
 * (Pfand-Auszahlung, Kassenlade) und wird immer abgewiesen.
 */
export function assertCashAllowed(
  settings: object | null | undefined,
  paymentMethod?: PaymentMethod | string | null,
): void {
  if (paymentMethod !== undefined && paymentMethod !== PaymentMethod.CASH) {
    return;
  }
  if (!isCashlessMode(settings)) return;
  throw new ForbiddenException({
    code: ErrorCodes.CASH_PAYMENTS_DISABLED,
    message:
      'Deine Organisation arbeitet bargeldlos. Bargeld kann über OpenEOS nicht erfasst oder ausgezahlt werden.',
  });
}

/**
 * Bereinigt `settings.payments` beim Speichern: nur bekannte Schluessel mit
 * dem richtigen Typ. Die Einstellungen sind sonst frei formbar, und ein
 * `cashless: "false"` (String) waere still als „aus“ gelesen worden.
 */
export function normalizePaymentSettings(input: unknown): {
  cashless?: boolean;
} {
  if (!input || typeof input !== 'object') return {};
  const cashless = (input as { cashless?: unknown }).cashless;
  return typeof cashless === 'boolean' ? { cashless } : {};
}
