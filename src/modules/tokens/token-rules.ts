import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  getOperatingMode,
  isTokensAllowed,
  orderOnlyModeError,
  paymentMethodNotAllowedCashlessError,
  type OperatingModeOrg,
} from '../../common/utils/operating-mode.util';
import { OrderItemStatus } from '../../database/entities/order-item.entity';
import type { PaymentTokenLine } from '../../database/entities/payment.entity';
import type { TokenKind } from '../../database/entities/token-type.entity';
import type {
  TokenTransactionLine,
  TokenTransactionTaxLine,
} from '../../database/entities/token-transaction.entity';

/**
 * Wertmarken — reine Regeln (ohne Datenbank), in Cent gerechnet.
 *
 * Steuerberater 2026-11-10, Frage 13 und Zusammenfassung Zeile 1:
 * - Marken, die fuer Speisen (7 %) und Getraenke (19 %) einloesbar sind,
 *   sind **Mehrzweckgutscheine** (§ 3 Abs. 15 UStG): Verkauf nicht
 *   steuerbar (DSFinV-K `MehrzweckgutscheinKauf`, 0-%-Slot, Schluessel 5),
 *   Umsatzsteuer bei der Einloesung mit dem Satz der Ware
 *   (`MehrzweckgutscheinEinloesung` negativ im 0-%-Slot + `Umsatz` je Satz).
 * - **Einzweckgutschein** (§ 3 Abs. 14 UStG) nur, wenn alle zuordenbaren
 *   Artikel denselben Satz haben: versteuert beim Verkauf mit diesem Satz
 *   (`EinzweckgutscheinKauf`), die Einloesung ist dann ohne Steuer
 *   (`EinzweckgutscheinEinloesung` negativ im Slot dieses Satzes).
 * - Kleinunternehmer: immer wie Mehrzweck (Einheitlichkeit).
 * - Annahme „an Geldes statt“ ist Kassenfunktion (AEAO zu § 146a Nr. 1.2):
 *   nur in „Alle Funktionen“, in Deutschland nur mit aktiver Cloud-TSE.
 */

export const cents = (value: number | string | null | undefined): number =>
  Math.round((Number(value) || 0) * 100);
const euros = (value: number): number => Math.round(value) / 100;

// ------------------------------------------------------------ Betriebsart

/** Siehe `isTokensAllowed` in operating-mode.util.ts. */
export { isTokensAllowed };

export function tseRequiredForTokensError(): ForbiddenException {
  return new ForbiddenException({
    code: ErrorCodes.TSE_REQUIRED_FOR_TOKENS,
    message:
      'Wertmarken gehen in Deutschland nur mit einer aktiven Cloud-TSE: Wer Marken an Geldes statt annimmt, hat eine Kassenfunktion (wie bei Bargeld).',
  });
}

/**
 * Sperrt Wertmarken ausserhalb von „Alle Funktionen“ bzw. in Deutschland
 * ohne aktive TSE — Verkauf, Annahme als Zahlung und Ruecktausch:
 * - „Nur Bons“: 403 ORDER_ONLY_MODE,
 * - „Bargeldlos“: 403 CASH_PAYMENTS_DISABLED (PAYMENT_METHOD_NOT_ALLOWED_CASHLESS),
 * - „Alle Funktionen“ in DE ohne aktive TSE: 403 TSE_REQUIRED_FOR_TOKENS.
 */
export function assertTokensAllowed(
  org: OperatingModeOrg | null | undefined,
): void {
  const mode = getOperatingMode(org);
  if (mode === 'orders_only') throw orderOnlyModeError();
  if (mode === 'cashless') throw paymentMethodNotAllowedCashlessError('tokens');
  if (!isTokensAllowed(org)) throw tseRequiredForTokensError();
}

// ---------------------------------------------------------------- Typen

export interface TokenTypeLike {
  id: string;
  name: string;
  value: number | string;
  kind: TokenKind;
  vatRate: number | string | null;
  allowedCategoryIds?: string[] | null;
  allowedProductIds?: string[] | null;
  eventId?: string | null;
  isActive?: boolean;
}

/**
 * Art fuer die Buchung: Kleinunternehmer (steuerbefreit) buchen immer als
 * Mehrzweckgutschein (Steuerberater 2026-11-10, Frage 13).
 */
export function effectiveKind(
  kind: TokenKind,
  vatExempt: boolean | undefined | null,
): TokenKind {
  return vatExempt !== false ? 'multi_purpose' : kind;
}

export function hasArticleRestriction(type: TokenTypeLike): boolean {
  return (
    (type.allowedCategoryIds?.length ?? 0) > 0 ||
    (type.allowedProductIds?.length ?? 0) > 0
  );
}

/** Gilt die Marke fuer alles (Ware, Pfand, Trinkgeld)? */
export function isUnrestricted(type: TokenTypeLike): boolean {
  return type.kind === 'multi_purpose' && !hasArticleRestriction(type);
}

export interface TokenItemLike {
  id: string;
  productId?: string | null;
  categoryId?: string | null;
  taxRate: number | string;
  status: string;
}

/** Ist die Position mit dieser Marke bezahlbar? */
export function isItemEligible(
  type: TokenTypeLike,
  item: TokenItemLike,
): boolean {
  if (String(item.status) === String(OrderItemStatus.CANCELLED)) return false;
  if (type.kind === 'single_purpose') {
    const rate = Math.round(Number(type.vatRate) * 100);
    if (Math.round(Number(item.taxRate) * 100) !== rate) return false;
  }
  if (!hasArticleRestriction(type)) return true;
  return (
    (!!item.productId &&
      (type.allowedProductIds ?? []).includes(item.productId)) ||
    (!!item.categoryId &&
      (type.allowedCategoryIds ?? []).includes(item.categoryId))
  );
}

/**
 * Pruefung eines Einzweckgutscheins (Steuerberater: „Einzweck nur, wenn
 * alle zugeordneten Artikel denselben Satz haben“). Ohne Beschraenkung auf
 * Artikel gilt der Typ fuer alle Artikel mit seinem Satz — die sind dann
 * per Definition einheitlich. Mit Beschraenkung muessen alle Artikel der
 * gewaehlten Kategorien und Artikel genau diesen Satz haben.
 * Liefert den Fehler (oder null).
 */
export function singlePurposeProblem(input: {
  vatRate: number | null | undefined;
  vatExempt: boolean | undefined | null;
  /** Saetze der Artikel, die die Beschraenkung trifft (leer = keine Beschraenkung). */
  restrictedRates: number[] | null;
}): {
  reason: string;
  message: string;
  params?: Record<string, unknown>;
} | null {
  if (input.vatExempt !== false) {
    return {
      reason: ErrorReasons.TOKEN_SINGLE_PURPOSE_SMALL_BUSINESS,
      message:
        'Als Kleinunternehmer buchst du Wertmarken immer als Mehrzweckgutschein (keine Umsatzsteuer, einheitlich).',
    };
  }
  const rate = Number(input.vatRate);
  if (input.vatRate === null || input.vatRate === undefined || !(rate > 0)) {
    return {
      reason: ErrorReasons.TOKEN_SINGLE_PURPOSE_RATE_REQUIRED,
      message:
        'Ein Einzweckgutschein braucht den einen Steuersatz, für den er gilt (z. B. 19 % für Getränke).',
    };
  }
  if (input.restrictedRates) {
    if (input.restrictedRates.length === 0) {
      return {
        reason: ErrorReasons.TOKEN_SINGLE_PURPOSE_NO_PRODUCTS,
        message:
          'Die gewählten Kategorien bzw. Artikel enthalten keine Artikel. Wähle Artikel aus, für die die Marke gilt.',
      };
    }
    const distinct = [
      ...new Set(input.restrictedRates.map((r) => Math.round(r * 100) / 100)),
    ].sort((a, b) => b - a);
    if (distinct.length > 1 || distinct[0] !== Math.round(rate * 100) / 100) {
      return {
        reason: ErrorReasons.TOKEN_SINGLE_PURPOSE_MIXED_RATES,
        message: `Ein Einzweckgutschein geht nur, wenn alle zugeordneten Artikel denselben Steuersatz haben (${rate} %). Gefunden: ${distinct.map((r) => `${r} %`).join(', ')}. Nimm einen Mehrzweckgutschein oder passe die Auswahl an.`,
        params: { rates: distinct, rate },
      };
    }
  }
  return null;
}

// ------------------------------------------------------------ Zuordnung

export interface TokenOrderItem extends TokenItemLike {
  /** Offener Betrag der Position in Cent (nach Rabatt). */
  openCents: number;
  /** Offenes Pfand der Position in Cent. */
  depositCents: number;
}

export interface TokenOrderInput {
  id: string;
  /** Offener Betrag der Bestellung (Cent, mit Trinkgeld). */
  dueCents: number;
  items: TokenOrderItem[];
}

export interface TokenTender {
  type: TokenTypeLike;
  count: number;
}

export interface TokenAllocation {
  /** Je Bestellung: Cent je Markentyp. */
  perOrder: Map<string, Map<string, number>>;
  /** Je Bestellung: Summe Cent. */
  totalByOrder: Map<string, number>;
  /** Nicht zuordenbarer Rest je Markentyp (Cent). */
  excessByType: Map<string, number>;
  excessCents: number;
  /** Bleibt nach den Marken noch Geld offen? (Cent, Summe) */
  moneyDueCents: number;
}

function rank(type: TokenTypeLike): number {
  if (type.kind === 'single_purpose') return 0;
  return hasArticleRestriction(type) ? 1 : 2;
}

/**
 * Verteilt die Marken einer Kassierung auf die Bestellungen.
 *
 * - Eingeschraenkte Marken zuerst (Einzweck, dann Mehrzweck mit
 *   Artikelauswahl), zuletzt die freien Mehrzweckmarken — so deckt jede
 *   Marke, was nur sie decken kann.
 * - Eingeschraenkte Marken decken nur passende Positionen (offener Betrag
 *   nach Rabatt), kein Pfand und kein Trinkgeld. Freie Mehrzweckmarken
 *   decken alles Offene (Ware, Pfand, Trinkgeld).
 * - Reihenfolge der Bestellungen wie angefragt.
 * Was nicht unterkommt, steht in `excessByType` (Ueberzahlung bzw. Marke
 * gilt nicht fuer diese Artikel).
 */
export function allocateTokens(
  orders: TokenOrderInput[],
  tenders: TokenTender[],
): TokenAllocation {
  // Offene Betraege je Bucket; Positionen auf den offenen Betrag gedeckelt.
  const state = orders.map((order) => {
    let left = Math.max(0, order.dueCents);
    const items = order.items.map((item) => {
      const open = Math.max(0, Math.min(item.openCents, left));
      left -= open;
      return { item, open };
    });
    const deposits = order.items.map((item) => {
      const open = Math.max(0, Math.min(item.depositCents, left));
      left -= open;
      return open;
    });
    return { order, items, deposits, other: left };
  });
  const perOrder = new Map<string, Map<string, number>>();
  const totalByOrder = new Map<string, number>(orders.map((o) => [o.id, 0]));
  const excessByType = new Map<string, number>();
  const book = (orderId: string, typeId: string, value: number) => {
    if (value <= 0) return;
    const map = perOrder.get(orderId) ?? new Map<string, number>();
    map.set(typeId, (map.get(typeId) ?? 0) + value);
    perOrder.set(orderId, map);
    totalByOrder.set(orderId, (totalByOrder.get(orderId) ?? 0) + value);
  };

  const sorted = tenders
    .filter((t) => t.count > 0)
    .map((t, index) => ({ ...t, index }))
    .sort((a, b) => rank(a.type) - rank(b.type) || a.index - b.index);

  for (const tender of sorted) {
    let rest = cents(tender.type.value) * Math.round(tender.count);
    const free = isUnrestricted(tender.type);
    for (const entry of state) {
      if (rest <= 0) break;
      for (const slot of entry.items) {
        if (rest <= 0) break;
        if (slot.open <= 0) continue;
        if (!free && !isItemEligible(tender.type, slot.item)) continue;
        const take = Math.min(slot.open, rest);
        slot.open -= take;
        rest -= take;
        book(entry.order.id, tender.type.id, take);
      }
      if (!free) continue;
      for (let i = 0; i < entry.deposits.length && rest > 0; i++) {
        const take = Math.min(entry.deposits[i], rest);
        entry.deposits[i] -= take;
        rest -= take;
        book(entry.order.id, tender.type.id, take);
      }
      if (rest > 0 && entry.other > 0) {
        const take = Math.min(entry.other, rest);
        entry.other -= take;
        rest -= take;
        book(entry.order.id, tender.type.id, take);
      }
    }
    if (rest > 0) {
      excessByType.set(
        tender.type.id,
        (excessByType.get(tender.type.id) ?? 0) + rest,
      );
    }
  }

  const excessCents = [...excessByType.values()].reduce((a, b) => a + b, 0);
  const moneyDueCents = orders.reduce(
    (sum, o) => sum + Math.max(0, o.dueCents - (totalByOrder.get(o.id) ?? 0)),
    0,
  );
  return { perOrder, totalByOrder, excessByType, excessCents, moneyDueCents };
}

/** Schnappschuss je Markentyp fuer eine Zahlung (Wert in Euro, Anteil Marken). */
export function paymentTokenLines(
  byType: Map<string, number> | undefined,
  types: Map<string, TokenTypeLike>,
  vatExempt: boolean | undefined | null,
): PaymentTokenLine[] {
  if (!byType) return [];
  const lines: PaymentTokenLine[] = [];
  for (const [typeId, value] of byType) {
    const type = types.get(typeId);
    if (!type || value <= 0) continue;
    const unit = cents(type.value);
    const kind = effectiveKind(type.kind, vatExempt);
    lines.push({
      tokenTypeId: type.id,
      name: type.name,
      kind,
      unitValue: euros(unit),
      count: unit > 0 ? Math.round((value / unit) * 1000) / 1000 : 0,
      amount: euros(value),
      vatRate:
        kind === 'single_purpose' && type.vatRate !== null
          ? Number(type.vatRate)
          : null,
    });
  }
  return lines;
}

/** Fehler: Marken uebersteigen, wofuer sie gelten (Artikelauswahl/Satz). */
export function tokenNotEligibleError(
  names: string[],
  excessCents: number,
): BadRequestException {
  return new BadRequestException({
    code: ErrorCodes.VALIDATION_ERROR,
    reason: ErrorReasons.TOKEN_NOT_ELIGIBLE,
    message: `${names.join(', ')}: Diese Marken gelten nicht für alle Artikel. ${(excessCents / 100).toFixed(2).replace('.', ',')} € lassen sich nicht damit bezahlen – nimm weniger Marken und kassiere den Rest anders.`,
    params: { tokenTypes: names, excess: excessCents / 100 },
  });
}

export function tokenOverpaymentError(
  excessCents: number,
): BadRequestException {
  return new BadRequestException({
    code: ErrorCodes.VALIDATION_ERROR,
    reason: ErrorReasons.TOKEN_OVERPAYMENT,
    message: `Die Marken sind ${(excessCents / 100).toFixed(2).replace('.', ',')} € mehr wert als der offene Betrag. Wechselgeld in Marken gibt es nicht: Nimm weniger Marken oder buche den Rest als Trinkgeld.`,
    params: { excess: excessCents / 100 },
  });
}

// --------------------------------------------------- Verkauf/Ruecktausch

/** MwSt-Zeilen eines Verkaufs/Ruecktauschs: nur Einzweckgutscheine. */
export function tokenTaxLines(
  lines: Pick<TokenTransactionLine, 'kind' | 'amount' | 'vatRate'>[],
  vatExempt: boolean | undefined | null,
): TokenTransactionTaxLine[] {
  if (vatExempt !== false) return [];
  const byRate = new Map<number, number>();
  for (const line of lines) {
    if (line.kind !== 'single_purpose' || !line.vatRate) continue;
    const rate = Number(line.vatRate);
    byRate.set(rate, (byRate.get(rate) ?? 0) + cents(line.amount));
  }
  return [...byRate.entries()]
    .filter(([, value]) => value !== 0)
    .sort(([a], [b]) => b - a)
    .map(([rate, value]) => {
      const sign = value < 0 ? -1 : 1;
      const tax = sign * Math.round((Math.abs(value) * rate) / (100 + rate));
      return {
        rate,
        gross: euros(value),
        tax: euros(tax),
        net: euros(value - tax),
      };
    });
}

/**
 * Bestand (ausgegeben, nicht eingeloest, nicht zurueckgetauscht) je Typ in
 * Cent. Verkauf + zurueckgegebene Einloesungen − Einloesungen −
 * Ruecktausch. Testbuchungen zaehlen nicht.
 */
export function outstandingCents(input: {
  soldCents: number;
  redeemedCents: number;
  boughtBackCents: number;
  reversedCents: number;
}): number {
  return (
    input.soldCents -
    input.redeemedCents -
    Math.abs(input.boughtBackCents) +
    input.reversedCents
  );
}
