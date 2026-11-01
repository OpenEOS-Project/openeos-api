import { ForbiddenException } from '@nestjs/common';
import { ErrorCodes } from '../constants/error-codes';
import { isCashlessMode } from './cashless-mode.util';

/**
 * Bargeld-Regel je Land (Entscheidung 2026-11-01, Schwerpunkt DACH).
 *
 * Hintergrund (BMF-Antwort 2026-10): Eine Kasse, die Bargeld erfassen
 * kann, braucht in Deutschland eine TSE — schon dann, wenn der Verein
 * Bargeld selbst einschalten koennte. Der vom Verein umschaltbare
 * bargeldlose Modus reicht dafuer nicht. Solange OpenEOS keine TSE
 * anbindet, sperrt der Server Bargeld deshalb fuer neue Organisationen in
 * Deutschland — ohne Schalter fuer den Verein.
 *
 * Ergebnis (`resolveCashPolicy`):
 *
 * | Organisation                                | Regel                |
 * |---------------------------------------------|----------------------|
 * | Bestand (`cash_policy_legacy = true`)        | `allowed`            |
 * | DE, TSE aktiv (`hasActiveTse`, spaeter)      | `allowed`            |
 * | DE, ohne TSE                                | `blocked_de_no_tse`  |
 * | AT, CH, alle anderen Laender                 | `allowed`            |
 * | ohne Land (nur Altbestand/Sonderfall)        | `allowed`            |
 *
 * Darueber liegen zwei weitere Schalter:
 * - Betriebsmodus „Nur Bestellen“ (operating-mode.util.ts) gewinnt immer:
 *   dort gibt es gar keine Zahlung (403 ORDER_ONLY_MODE, vor dieser Regel).
 * - Der bargeldlose Modus des Vereins (`settings.payments.cashless`) gilt,
 *   wo Bargeld nach dieser Regel erlaubt ist (403 CASH_PAYMENTS_DISABLED).
 *
 * Einzige Quelle fuer das Land ist die Spalte `organizations.country`.
 * `settings.address.country` ist nur noch eine Kopie fuer aeltere Leser und
 * wird bei jeder Aenderung des Landes mitgeschrieben.
 */
export const CASH_POLICIES = ['allowed', 'blocked_de_no_tse'] as const;
export type CashPolicy = (typeof CASH_POLICIES)[number];

/**
 * Kurzer Grund fuer die Oberflaeche:
 * - `legacy`: Bestandsorganisation, verhaelt sich wie bisher.
 * - `de_no_tse`: Deutschland ohne TSE, Bargeld gesperrt.
 * - `de_tse`: Deutschland mit aktiver TSE, Bargeld erlaubt.
 * - `country`: Land ohne Sperre (AT, CH, alle anderen).
 * - `no_country`: kein Land hinterlegt.
 */
export type CashPolicyReason =
  | 'legacy'
  | 'de_no_tse'
  | 'de_tse'
  | 'country'
  | 'no_country';

/** Was die Regel von einer Organisation braucht. */
export interface CashPolicyOrg {
  settings?: object | null;
  country?: string | null;
  cashPolicyLegacy?: boolean | null;
}

/**
 * Spalten, die jede Abfrage fuer `assertCashAllowed` laden muss. Fehlt eine
 * davon (z. B. `select: { id, settings }`), saehe eine neue deutsche
 * Organisation wie eine ohne Land aus und Bargeld waere offen.
 */
export const CASH_POLICY_SELECT = {
  id: true,
  settings: true,
  country: true,
  cashPolicyLegacy: true,
} as const;

/**
 * Pruefung „TSE aktiv?“. Heute immer false: OpenEOS bindet die Swissbit
 * Cloud-TSE erst an. Die TSE-Integration ersetzt `isActive`, sobald es sie
 * gibt — dann duerfen deutsche Organisationen mit aktiver TSE automatisch
 * wieder Bargeld annehmen (`de_tse`), ohne weitere Aenderung hier. Tests
 * setzen den Haken ueber diese Stelle.
 */
export const tseHook: {
  isActive: (org: CashPolicyOrg | null | undefined) => boolean;
} = {
  isActive: () => false,
};

/** Hat die Organisation eine aktive TSE? (Heute: nie, siehe `tseHook`.) */
export function hasActiveTse(org: CashPolicyOrg | null | undefined): boolean {
  return tseHook.isActive(org);
}

export function cashPolicyReason(
  org: CashPolicyOrg | null | undefined,
): CashPolicyReason {
  if (org?.cashPolicyLegacy === true) return 'legacy';
  const country = (org?.country ?? '').toUpperCase();
  if (!country) return 'no_country';
  if (country === 'DE') return hasActiveTse(org) ? 'de_tse' : 'de_no_tse';
  return 'country';
}

export function resolveCashPolicy(
  org: CashPolicyOrg | null | undefined,
): CashPolicy {
  return cashPolicyReason(org) === 'de_no_tse'
    ? 'blocked_de_no_tse'
    : 'allowed';
}

/** Ist Bargeld durch die Landesregel gesperrt (nicht durch den Schalter)? */
export function isCashBlockedByPolicy(
  org: CashPolicyOrg | null | undefined,
): boolean {
  return resolveCashPolicy(org) === 'blocked_de_no_tse';
}

/** Gesperrt durch Landesregel oder bargeldlosen Modus. */
export function isCashBlocked(org: CashPolicyOrg | null | undefined): boolean {
  return isCashBlockedByPolicy(org) || isCashlessMode(org?.settings);
}

/** Felder fuer Antworten an Oberflaeche und Kasse. */
export function cashPolicyView(org: CashPolicyOrg | null | undefined): {
  country: string | null;
  cashPolicy: CashPolicy;
  cashPolicyLegacy: boolean;
  cashPolicyReason: CashPolicyReason;
} {
  return {
    country: org?.country ?? null,
    cashPolicy: resolveCashPolicy(org),
    cashPolicyLegacy: org?.cashPolicyLegacy === true,
    cashPolicyReason: cashPolicyReason(org),
  };
}

export function cashNotAllowedInCountryError(): ForbiddenException {
  return new ForbiddenException({
    code: ErrorCodes.CASH_NOT_ALLOWED_IN_COUNTRY,
    message:
      'Bargeld kann deine Organisation in OpenEOS nicht erfassen: In Deutschland braucht eine Kasse mit Bargeld eine TSE, und die bietet OpenEOS noch nicht an. Karte und Online-Zahlung gehen weiter; bar kassierte Bestellungen schließt du mit „Ohne Zahlung abschließen“ ab.',
  });
}

/**
 * Weist Bargeld ab, wo es nicht erlaubt ist:
 * - Landesregel (DE ohne TSE): 403 `CASH_NOT_ALLOWED_IN_COUNTRY`,
 * - bargeldloser Modus des Vereins: 403 `CASH_PAYMENTS_DISABLED`.
 *
 * Mit Zahlart: nur `cash` wird abgewiesen, Karte, SumUp und Online-Zahlung
 * laufen weiter. Ohne Zahlart (`undefined`) ist der Vorgang selbst ein
 * reiner Bargeldvorgang (Pfand-Auszahlung, Kassenlade) und wird immer
 * abgewiesen, wenn Bargeld gesperrt ist.
 *
 * Den Betriebsmodus „Nur Bestellen“ prueft der Aufrufer vorher
 * (`assertPaymentsAllowed`).
 */
export function assertCashAllowed(
  org: CashPolicyOrg | null | undefined,
  paymentMethod?: string | null,
): void {
  // `PaymentMethod.CASH`; als Text, damit das Organisations-Entity diese
  // Datei ohne Kreisimport ueber die Zahlungs-Entities laden kann.
  if (paymentMethod !== undefined && paymentMethod !== 'cash') {
    return;
  }
  if (isCashBlockedByPolicy(org)) throw cashNotAllowedInCountryError();
  if (!isCashlessMode(org?.settings)) return;
  throw new ForbiddenException({
    code: ErrorCodes.CASH_PAYMENTS_DISABLED,
    message:
      'Deine Organisation arbeitet bargeldlos. Bargeld kann über OpenEOS nicht erfasst oder ausgezahlt werden.',
  });
}

/**
 * `settings.address.country` ist nur eine Kopie von `organizations.country`.
 * Was beim Bearbeiten der Einstellungen dort ankommt, wird durch die Spalte
 * ersetzt (bzw. entfernt, solange kein Land gesetzt ist) — das Land aendert
 * sich nur ueber die eigenen, protokollierten Wege.
 */
export function keepCountryMirror(
  incoming: Record<string, unknown> | null | undefined,
  country: string | null | undefined,
): void {
  const address = incoming?.address;
  if (!address || typeof address !== 'object') return;
  const target = address as Record<string, unknown>;
  if (country) target.country = country;
  else delete target.country;
}
