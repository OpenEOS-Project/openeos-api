import {
  OrderItem,
  OrderItemStatus,
} from '../../database/entities/order-item.entity';
import type { RefundTaxLine } from '../../database/entities/refund.entity';

/**
 * Reine Rechenhilfen fuer Storno und Erstattung (ohne Datenbank, in
 * Cent gerechnet, damit Summen exakt aufgehen).
 *
 * Eine Bestellung setzt sich zusammen aus Warenwert je MwSt-Satz (nach
 * anteiligem Rabatt), Pfand (nicht steuerbar) und Trinkgeld (kein
 * Entgelt). Eine Erstattung nimmt von diesen Teilen etwas zurueck; ihr
 * Gegenbeleg weist dieselben Teile negativ aus.
 */

export const round2 = (value: number): number => Math.round(value * 100) / 100;
export const cents = (value: number): number => Math.round(Number(value) * 100);

type ItemLike = Pick<
  OrderItem,
  | 'quantity'
  | 'unitPrice'
  | 'optionsPrice'
  | 'totalPrice'
  | 'taxRate'
  | 'status'
  | 'depositAmount'
>;

/** Zusammensetzung in Cent: Warenwert je Satz, Pfand, Trinkgeld. */
export interface Composition {
  goods: Map<number, number>;
  pfand: number;
  tip: number;
}

export function emptyComposition(): Composition {
  return { goods: new Map(), pfand: 0, tip: 0 };
}

export function compositionTotal(c: Composition): number {
  let sum = c.pfand + c.tip;
  for (const value of c.goods.values()) sum += value;
  return sum;
}

/** Stueckpreis brutto inkl. Optionen. */
export function unitGross(item: Pick<OrderItem, 'unitPrice' | 'optionsPrice'>) {
  return round2(Number(item.unitPrice) + Number(item.optionsPrice || 0));
}

/** Anteil, der nach Rabatt vom Warenwert bleibt (0..1). */
export function discountFactor(
  items: Pick<OrderItem, 'totalPrice' | 'status'>[],
  discountAmount: number | null | undefined,
): number {
  const subtotal = items
    .filter((i) => i.status !== OrderItemStatus.CANCELLED)
    .reduce((sum, i) => sum + Number(i.totalPrice), 0);
  if (subtotal <= 0) return 0;
  const discount = Math.min(Math.max(Number(discountAmount) || 0, 0), subtotal);
  return (subtotal - discount) / subtotal;
}

/**
 * Zusammensetzung der Bestellung, wie sie jetzt verkauft ist (stornierte
 * Positionen zaehlen nicht). Rundungsdifferenzen des Rabatts landen beim
 * groessten Satz, damit die Summe exakt `total` ergibt.
 */
export function orderComposition(
  items: ItemLike[],
  order: { discountAmount: number; tipAmount: number; total: number },
): Composition {
  const active = items.filter((i) => i.status !== OrderItemStatus.CANCELLED);
  const factor = discountFactor(active, order.discountAmount);
  const goods = new Map<number, number>();
  let pfand = 0;
  for (const item of active) {
    const rate = Number(item.taxRate) || 0;
    goods.set(
      rate,
      (goods.get(rate) ?? 0) + Math.round(cents(item.totalPrice) * factor),
    );
    pfand += cents(item.depositAmount || 0) * item.quantity;
  }
  const composition: Composition = {
    goods,
    pfand,
    tip: cents(order.tipAmount),
  };
  const diff = cents(order.total) - compositionTotal(composition);
  if (diff !== 0 && goods.size > 0) {
    const biggest = [...goods.entries()].sort((a, b) => b[1] - a[1])[0][0];
    goods.set(biggest, (goods.get(biggest) ?? 0) + diff);
  }
  return composition;
}

export function subtractComposition(
  a: Composition,
  b: Composition,
): Composition {
  const goods = new Map(a.goods);
  for (const [rate, value] of b.goods) {
    goods.set(rate, (goods.get(rate) ?? 0) - value);
  }
  return {
    goods,
    pfand: a.pfand - b.pfand,
    tip: a.tip - b.tip,
  };
}

function clampComposition(c: Composition): Composition {
  const goods = new Map<number, number>();
  for (const [rate, value] of c.goods) if (value > 0) goods.set(rate, value);
  return { goods, pfand: Math.max(0, c.pfand), tip: Math.max(0, c.tip) };
}

/**
 * Verteilt `amountCents` anteilig auf die Teile von `base`. Der letzte Teil
 * nimmt die Rundung auf, die Summe stimmt also immer exakt.
 */
export function scaleComposition(
  base: Composition,
  amountCents: number,
): Composition {
  const clean = clampComposition(base);
  const parts: { key: string; value: number }[] = [
    ...[...clean.goods.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([rate, value]) => ({ key: `g:${rate}`, value })),
    { key: 'pfand', value: clean.pfand },
    { key: 'tip', value: clean.tip },
  ].filter((p) => p.value > 0);
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  const out = emptyComposition();
  if (total <= 0 || amountCents <= 0) return out;
  let assigned = 0;
  parts.forEach((part, index) => {
    const share =
      index === parts.length - 1
        ? amountCents - assigned
        : Math.round((amountCents * part.value) / total);
    assigned += share;
    if (part.key === 'pfand') out.pfand += share;
    else if (part.key === 'tip') out.tip += share;
    else {
      const rate = Number(part.key.slice(2));
      out.goods.set(rate, (out.goods.get(rate) ?? 0) + share);
    }
  });
  return out;
}

/**
 * Freier Betrag: mindert zuerst den Warenwert (anteilig je Satz), erst was
 * darueber hinausgeht, geht an Pfand und danach Trinkgeld.
 */
export function amountComposition(
  remaining: Composition,
  amountCents: number,
): Composition {
  const clean = clampComposition(remaining);
  const goodsTotal = [...clean.goods.values()].reduce((s, v) => s + v, 0);
  const fromGoods = Math.min(goodsTotal, amountCents);
  const goodsPart = scaleComposition(
    { goods: clean.goods, pfand: 0, tip: 0 },
    fromGoods,
  );
  let rest = amountCents - fromGoods;
  const pfand = Math.min(clean.pfand, rest);
  rest -= pfand;
  const tip = Math.min(clean.tip, rest);
  rest -= tip;
  // Was dann noch bleibt (nur bei Rundung), zaehlt zum Warenwert.
  if (rest > 0) {
    const rate = [...goodsPart.goods.keys()][0] ?? 0;
    goodsPart.goods.set(rate, (goodsPart.goods.get(rate) ?? 0) + rest);
  }
  return { goods: goodsPart.goods, pfand, tip };
}

/** MwSt-Zeilen (negativ) aus einer Zusammensetzung (Cent, positiv). */
export function refundTaxLines(
  c: Composition,
  vatExempt: boolean | undefined,
): RefundTaxLine[] {
  if (vatExempt !== false) return [];
  return [...c.goods.entries()]
    .filter(([rate, value]) => rate > 0 && value > 0)
    .sort(([a], [b]) => b - a)
    .map(([rate, value]) => {
      const gross = value / 100;
      const tax = round2((gross * rate) / (100 + rate));
      return {
        rate,
        gross: -round2(gross),
        tax: -tax,
        net: -round2(gross - tax),
      };
    });
}

export interface ItemSelection<T> {
  item: T;
  quantity: number;
}

export interface ItemRefundLine<T> {
  item: T;
  quantity: number;
  /** Warenwert in Cent (positiv), nach anteiligem Rabatt. */
  goods: number;
  /** Pfand in Cent (positiv). */
  deposit: number;
}

/**
 * Kulanz-Erstattung nach Positionen (ohne Storno): je Stueck der
 * Bruttopreis inkl. Optionen, gemindert um den anteiligen Rabatt, dazu auf
 * Wunsch das Pfand.
 */
export function itemsRefund<T extends ItemLike>(
  allItems: T[],
  selections: ItemSelection<T>[],
  discountAmount: number,
  includeDeposit: boolean,
): { lines: ItemRefundLine<T>[]; composition: Composition } {
  const factor = discountFactor(allItems, discountAmount);
  const composition = emptyComposition();
  const lines = selections.map(({ item, quantity }) => {
    const goods = Math.round(cents(unitGross(item)) * quantity * factor);
    const deposit = includeDeposit
      ? cents(item.depositAmount || 0) * quantity
      : 0;
    const rate = Number(item.taxRate) || 0;
    composition.goods.set(rate, (composition.goods.get(rate) ?? 0) + goods);
    composition.pfand += deposit;
    return { item, quantity, goods, deposit };
  });
  return { lines, composition };
}

export interface RefundablePayment {
  id: string;
  /** Noch erstattbar in Cent. */
  refundable: number;
  isProvider: boolean;
  createdAt: Date;
}

/**
 * Verteilt einen Erstattungsbetrag auf Zahlungen: die gewaehlte Zahlung
 * allein, sonst von der juengsten rueckwaerts. Liefert null, wenn die
 * Zahlungen nicht reichen.
 */
export function allocateRefund(
  payments: RefundablePayment[],
  amountCents: number,
  preferredId?: string | null,
): { paymentId: string; amount: number }[] | null {
  if (preferredId) {
    const payment = payments.find((p) => p.id === preferredId);
    if (!payment || payment.refundable < amountCents) return null;
    return [{ paymentId: payment.id, amount: amountCents }];
  }
  const ordered = [...payments]
    .filter((p) => p.refundable > 0)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const out: { paymentId: string; amount: number }[] = [];
  let rest = amountCents;
  for (const payment of ordered) {
    if (rest <= 0) break;
    const take = Math.min(payment.refundable, rest);
    out.push({ paymentId: payment.id, amount: take });
    rest -= take;
  }
  return rest > 0 ? null : out;
}

/** Status in der Liste: genau einer je Bestellung (gleich in Kasse und Verwaltung). */
export const ORDER_DISPLAY_STATUSES = [
  'in_kitchen',
  'ready',
  'completed',
  'unpaid',
  'cancelled',
  'partly_refunded',
  'refunded',
] as const;
export type OrderDisplayStatus = (typeof ORDER_DISPLAY_STATUSES)[number];

/** SQL-Ausdruck fuer `ORDER_DISPLAY_STATUSES` (Alias der Bestellung). */
export function displayStatusSql(alias: string): string {
  return `(CASE
    WHEN ${alias}.status = 'cancelled' THEN 'cancelled'
    WHEN ${alias}.refunded_amount > 0 AND ${alias}.refunded_amount >= ${alias}.paid_amount THEN 'refunded'
    WHEN ${alias}.refunded_amount > 0 THEN 'partly_refunded'
    WHEN ${alias}.payment_status IN ('unpaid', 'partly_paid') AND ${alias}.total > 0 THEN 'unpaid'
    WHEN ${alias}.status = 'completed' THEN 'completed'
    WHEN ${alias}.status = 'ready' THEN 'ready'
    ELSE 'in_kitchen'
  END)`;
}

/** Dieselbe Regel wie `displayStatusSql`, fuer bereits geladene Bestellungen. */
export function displayStatusOf(order: {
  status: string;
  paymentStatus: string;
  total: number;
  paidAmount: number;
  refundedAmount?: number | null;
}): OrderDisplayStatus {
  const refunded = cents(order.refundedAmount ?? 0);
  if (order.status === 'cancelled') return 'cancelled';
  if (refunded > 0 && refunded >= cents(order.paidAmount)) return 'refunded';
  if (refunded > 0) return 'partly_refunded';
  if (
    (order.paymentStatus === 'unpaid' ||
      order.paymentStatus === 'partly_paid') &&
    cents(order.total) > 0
  ) {
    return 'unpaid';
  }
  if (order.status === 'completed') return 'completed';
  if (order.status === 'ready') return 'ready';
  return 'in_kitchen';
}
