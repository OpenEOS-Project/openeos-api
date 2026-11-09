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
 * anteiligem Rabatt), Pfand je MwSt-Satz (Teil des Entgelts, Satz der
 * Pfandart; Bestand von vor 2026-11 nicht steuerbar = 0 %) und Trinkgeld
 * (kein Entgelt). Eine Erstattung nimmt von diesen Teilen etwas zurueck;
 * ihr Gegenbeleg weist dieselben Teile negativ aus.
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
> &
  Partial<Pick<OrderItem, 'depositTaxRate'>>;

/**
 * Steuersatz des Pfands einer Position. NULL (Bestand von vor der
 * Umstellung, 2026-11) heisst: nicht steuerbar, also 0 % — so stand es
 * damals auf Bon, TSE und im Bericht, und so bleibt es fuer diese Daten.
 */
export function depositRateOf(
  item: { depositTaxRate?: number | string | null } | null | undefined,
): number {
  const raw = item?.depositTaxRate;
  if (raw === null || raw === undefined || raw === '') return 0;
  const rate = Number(raw);
  return Number.isFinite(rate) ? rate : 0;
}

/**
 * Zusammensetzung in Cent: Warenwert je Satz, Pfand je Satz, Trinkgeld.
 * Pfand-Schluessel 0 = nicht steuerbar (Bestand) bzw. Pfandart mit 0 %.
 */
export interface Composition {
  goods: Map<number, number>;
  pfand: Map<number, number>;
  tip: number;
}

export function emptyComposition(): Composition {
  return { goods: new Map(), pfand: new Map(), tip: 0 };
}

/** Summe der Werte einer Satz-Map (Cent). */
export function mapSum(map: Map<number, number>): number {
  let sum = 0;
  for (const value of map.values()) sum += value;
  return sum;
}

/** Pfand gesamt (Cent). */
export function pfandSum(c: Pick<Composition, 'pfand'>): number {
  return mapSum(c.pfand);
}

/** Pfand-Map aus einem einzelnen Betrag (Bestand ohne Satz: 0 %). */
export function pfandMap(cents: number, rate = 0): Map<number, number> {
  return cents
    ? new Map<number, number>([[rate, cents]])
    : new Map<number, number>();
}

function addTo(map: Map<number, number>, rate: number, value: number) {
  map.set(rate, (map.get(rate) ?? 0) + value);
}

export function compositionTotal(c: Composition): number {
  return mapSum(c.goods) + mapSum(c.pfand) + c.tip;
}

/** Fuer `metadata`/TSE-Kopie: `{ "19": 200 }` (Schluessel als Text). */
export function rateRecord(map: Map<number, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].map(([r, v]) => [String(r), v]));
}

/** Gegenstueck zu `rateRecord`; `sign` 1 = wie gespeichert, `abs` = Betrag. */
export function rateMapFrom(
  record: Record<string, unknown> | null | undefined,
  abs = false,
): Map<number, number> {
  const map = new Map<number, number>();
  for (const [rate, value] of Object.entries(record ?? {})) {
    const v = Number(value) || 0;
    if (v) addTo(map, Number(rate), abs ? Math.abs(v) : v);
  }
  return map;
}

/**
 * Pfand aus einer gespeicherten Zusammensetzung (`metadata.composition`
 * bzw. TSE-Kopie): `pfandByRate` ab 2026-11, sonst der Gesamtbetrag
 * `pfand` als nicht steuerbar (0 %).
 */
export function pfandFromRecord(
  raw: { pfand?: unknown; pfandByRate?: unknown } | null | undefined,
  abs = false,
): Map<number, number> {
  if (raw?.pfandByRate && typeof raw.pfandByRate === 'object') {
    return rateMapFrom(raw.pfandByRate as Record<string, unknown>, abs);
  }
  const total = Number(raw?.pfand) || 0;
  return pfandMap(abs ? Math.abs(total) : total);
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
  const pfand = new Map<number, number>();
  for (const item of active) {
    const rate = Number(item.taxRate) || 0;
    goods.set(
      rate,
      (goods.get(rate) ?? 0) + Math.round(cents(item.totalPrice) * factor),
    );
    const deposit = cents(item.depositAmount || 0) * item.quantity;
    if (deposit) addTo(pfand, depositRateOf(item), deposit);
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
  for (const [rate, value] of b.goods) addTo(goods, rate, -value);
  const pfand = new Map(a.pfand);
  for (const [rate, value] of b.pfand) addTo(pfand, rate, -value);
  return { goods, pfand, tip: a.tip - b.tip };
}

export function addComposition(a: Composition, b: Composition): Composition {
  const goods = new Map(a.goods);
  for (const [rate, value] of b.goods) addTo(goods, rate, value);
  const pfand = new Map(a.pfand);
  for (const [rate, value] of b.pfand) addTo(pfand, rate, value);
  return { goods, pfand, tip: a.tip + b.tip };
}

function positiveOnly(map: Map<number, number>): Map<number, number> {
  const out = new Map<number, number>();
  for (const [rate, value] of map) if (value > 0) out.set(rate, value);
  return out;
}

function clampComposition(c: Composition): Composition {
  return {
    goods: positiveOnly(c.goods),
    pfand: positiveOnly(c.pfand),
    tip: Math.max(0, c.tip),
  };
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
    ...[...clean.pfand.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([rate, value]) => ({ key: `p:${rate}`, value })),
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
    if (part.key === 'tip') out.tip += share;
    else {
      const rate = Number(part.key.slice(2));
      addTo(part.key.startsWith('p:') ? out.pfand : out.goods, rate, share);
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
    { goods: clean.goods, pfand: new Map(), tip: 0 },
    fromGoods,
  );
  let rest = amountCents - fromGoods;
  const fromPfand = Math.min(mapSum(clean.pfand), rest);
  const pfand = scaleComposition(
    { goods: new Map(), pfand: clean.pfand, tip: 0 },
    fromPfand,
  ).pfand;
  rest -= fromPfand;
  const tip = Math.min(clean.tip, rest);
  rest -= tip;
  // Was dann noch bleibt (nur bei Rundung), zaehlt zum Warenwert.
  if (rest > 0) {
    const rate = [...goodsPart.goods.keys()][0] ?? 0;
    goodsPart.goods.set(rate, (goodsPart.goods.get(rate) ?? 0) + rest);
  }
  return { goods: goodsPart.goods, pfand, tip };
}

/**
 * Brutto je Satz einer Zusammensetzung: Ware und Pfand zusammen (Pfand ist
 * Teil des Entgelts und traegt den Satz seiner Pfandart). Trinkgeld zaehlt
 * nicht zum Entgelt.
 */
export function taxableByRate(c: Composition): Map<number, number> {
  const out = new Map(c.goods);
  for (const [rate, value] of c.pfand) addTo(out, rate, value);
  return out;
}

/** MwSt-Zeilen (negativ) aus einer Zusammensetzung (Cent, positiv). */
export function refundTaxLines(
  c: Composition,
  vatExempt: boolean | undefined,
): RefundTaxLine[] {
  if (vatExempt !== false) return [];
  return [...taxableByRate(c).entries()]
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
    if (deposit) addTo(composition.pfand, depositRateOf(item), deposit);
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
  /** Barzahlung — im bargeldlosen Modus nicht erstattbar. */
  isCash?: boolean;
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

/**
 * Wie `allocateRefund`, ohne Bargeld (Betriebsart `cashless`, `orders_only`
 * oder Deutschland ohne TSE) aber nur auf unbare Zahlungen (Karte, SumUp,
 * online). `cashBlocked`: der Betrag liesse sich nur mit einer Barzahlung
 * erstatten — die Erstattung wird dann abgewiesen, statt Geld aus der
 * Kasse zu geben.
 */
export function allocateRefundFor(
  payments: RefundablePayment[],
  amountCents: number,
  preferredId: string | null | undefined,
  cashless: boolean,
): {
  allocation: { paymentId: string; amount: number }[] | null;
  cashBlocked: boolean;
} {
  if (!cashless) {
    return {
      allocation: allocateRefund(payments, amountCents, preferredId),
      cashBlocked: false,
    };
  }
  if (preferredId && payments.find((p) => p.id === preferredId)?.isCash) {
    return { allocation: null, cashBlocked: true };
  }
  const allocation = allocateRefund(
    payments.filter((p) => !p.isCash),
    amountCents,
    preferredId,
  );
  return {
    allocation,
    cashBlocked:
      !allocation && payments.some((p) => p.isCash && p.refundable > 0),
  };
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
    WHEN ${alias}.payment_status IN ('unpaid', 'partly_paid') AND ${alias}.total > 0
      AND ${alias}.closed_without_payment_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM organizations dso
        WHERE dso.id = ${alias}.organization_id
          AND dso.operating_mode = 'orders_only') THEN 'unpaid'
    WHEN ${alias}.status = 'completed' THEN 'completed'
    WHEN ${alias}.status = 'ready' THEN 'ready'
    ELSE 'in_kitchen'
  END)`;
}

/** Dieselbe Regel wie `displayStatusSql`, fuer bereits geladene Bestellungen. */
export function displayStatusOf(
  order: {
    status: string;
    paymentStatus: string;
    total: number;
    paidAmount: number;
    refundedAmount?: number | null;
    /** „Ohne Zahlung abgeschlossen“: nie „offen“. */
    closedWithoutPaymentAt?: Date | string | null;
  },
  options: { orderOnly?: boolean } = {},
): OrderDisplayStatus {
  const refunded = cents(order.refundedAmount ?? 0);
  if (order.status === 'cancelled') return 'cancelled';
  if (refunded > 0 && refunded >= cents(order.paidAmount)) return 'refunded';
  if (refunded > 0) return 'partly_refunded';
  // „Nur Bons“: kassiert wird ausserhalb — „offen“ gibt es nicht.
  if (
    !options.orderOnly &&
    !order.closedWithoutPaymentAt &&
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
