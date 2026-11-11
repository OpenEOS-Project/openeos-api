import type {
  SettlementCount,
  SettlementTotals,
} from '../../database/entities/waiter-settlement.entity';
import type { OperatingMode } from '../../common/utils/operating-mode.util';

/**
 * Rechnung der Kellnerabrechnung (bedienungen-plan.md §7), ohne
 * Datenbank: Die Abfragen liefern Gruppen, diese Funktion bildet daraus den
 * Schnappschuss. Testbuchungen zaehlen nur als „Training“, nie im Geld.
 */

/** Zahlungen je Zahlart, Testkennzeichen und Geraet. */
export interface PaymentGroupRow {
  method: string;
  isTest: boolean;
  deviceId: string | null;
  deviceName: string | null;
  count: number | string;
  amount: number | string;
  tip: number | string;
}

/** Erstattungen/Storno (Betraege negativ wie im Gegenbeleg). */
export interface RefundGroupRow {
  method: string;
  isTest: boolean;
  deviceId?: string | null;
  deviceName?: string | null;
  count: number | string;
  amount: number | string;
}

export interface PfandGroupRow {
  isTest: boolean;
  deviceId?: string | null;
  deviceName?: string | null;
  count: number | string;
  amount: number | string;
}

/** Aufgenommene Bestellungen (Ersteller) und Runden (Sender). */
export interface TakenGroupRow {
  isTest: boolean;
  orders: number | string;
  discounts: number | string;
}

export interface ItemGroupRow {
  isTest: boolean;
  items: number | string;
  revenue: number | string;
}

/** Angenommene Wertmarken je Typ (aus `payments.token_lines`). */
export interface TokenRedemptionGroupRow {
  isTest: boolean;
  tokenTypeId: string;
  name: string;
  unitValue: number | string;
  count: number | string;
  amount: number | string;
}

/** Verkauf/Ruecktausch von Wertmarken je Art, Zahlart und Geraet. */
export interface TokenTransactionGroupRow {
  kind: 'sale' | 'buyback';
  method: string;
  isTest: boolean;
  deviceId?: string | null;
  deviceName?: string | null;
  /** Stueck (Summe der Positionen). */
  count: number | string;
  /** Euro (Ruecktausch negativ). */
  amount: number | string;
}

export interface SettlementInput {
  operatingMode: OperatingMode;
  payments: PaymentGroupRow[];
  refunds: RefundGroupRow[];
  pfandReturns: PfandGroupRow[];
  taken: TakenGroupRow[];
  items: ItemGroupRow[];
  tokenRedemptions?: TokenRedemptionGroupRow[];
  tokenTransactions?: TokenTransactionGroupRow[];
}

export const CASH_METHODS = new Set(['cash']);
/** Karte: SumUp-Terminal oder fremdes Kartengeraet. */
export const CARD_METHODS = new Set(['card', 'sumup_terminal']);

export type MethodGroup = 'cash' | 'card' | 'other';

export function methodGroup(method: string): MethodGroup {
  if (CASH_METHODS.has(method)) return 'cash';
  if (CARD_METHODS.has(method)) return 'card';
  return 'other';
}

export const round2 = (value: number): number =>
  Math.round((value + Number.EPSILON) * 100) / 100;

const num = (value: number | string | null | undefined): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const zero = (): SettlementCount => ({ count: 0, amount: 0 });

function add(target: SettlementCount, count: number, amount: number): void {
  target.count += count;
  target.amount = round2(target.amount + amount);
}

/** Hat der Zeitraum ueberhaupt etwas (echt oder Training)? */
export function settlementIsEmpty(totals: SettlementTotals): boolean {
  const real =
    totals.taken.orders +
    totals.taken.items +
    (totals.payments?.total.count ?? 0) +
    (totals.refunds?.total.count ?? 0) +
    (totals.pfandReturns?.count ?? 0) +
    (totals.tokens ? 1 : 0);
  const training = totals.training.orders + totals.training.payments;
  return real === 0 && training === 0;
}

/** Nur Testbuchungen (Training), nichts Echtes? */
export function settlementIsTrainingOnly(totals: SettlementTotals): boolean {
  const real =
    totals.taken.orders +
    totals.taken.items +
    (totals.payments?.total.count ?? 0) +
    (totals.refunds?.total.count ?? 0) +
    (totals.pfandReturns?.count ?? 0) +
    (totals.tokens ? 1 : 0);
  return real === 0 && !settlementIsEmpty(totals);
}

/**
 * Schnappschuss der Zahlen. „Soll bar“ = Barzahlungen − Bar-Erstattungen −
 * Pfand-Auszahlungen + Wertmarken bar verkauft − Wertmarken-Ruecktausch
 * (angenommene Marken sind kein Bargeld; ohne Kellnerbrieftasche kein Wechselgeld: das
 * Bargeld liegt in der Schublade des Geraets, an dem kassiert bzw.
 * ausgezahlt wurde — `cashByDevice`). In „Nur Bons“ nur Mengen.
 */
export function buildSettlementTotals(
  input: SettlementInput,
): SettlementTotals {
  const payments = {
    cash: zero(),
    card: zero(),
    other: zero(),
    total: zero(),
  };
  const refunds = { cash: zero(), nonCash: zero(), total: zero() };
  const pfandReturns = zero();
  const training = { orders: 0, payments: 0, amount: 0 };
  let tips = 0;
  const cashByDevice = new Map<
    string,
    { deviceId: string | null; deviceName: string | null; amount: number }
  >();
  const drawer = (deviceId: string | null, deviceName: string | null) => {
    const key = deviceId ?? '';
    let entry = cashByDevice.get(key);
    if (!entry) {
      entry = { deviceId, deviceName, amount: 0 };
      cashByDevice.set(key, entry);
    }
    return entry;
  };

  for (const row of input.payments) {
    const count = num(row.count);
    const amount = num(row.amount);
    if (row.isTest) {
      training.payments += count;
      training.amount = round2(training.amount + amount);
      continue;
    }
    // Nur mit Wertmarken bezahlt: kein Geld (Marken stehen unter `tokens`),
    // Trinkgeld aus der Ueberzahlung zaehlt trotzdem.
    if (row.method === 'tokens') {
      tips = round2(tips + num(row.tip));
      continue;
    }
    const group = methodGroup(row.method);
    add(payments[group], count, amount);
    add(payments.total, count, amount);
    tips = round2(tips + num(row.tip));
    if (group === 'cash') {
      const entry = drawer(row.deviceId, row.deviceName);
      entry.amount = round2(entry.amount + amount);
    }
  }

  for (const row of input.refunds) {
    if (row.isTest) continue;
    const count = num(row.count);
    const amount = Math.abs(num(row.amount));
    const cash = methodGroup(row.method) === 'cash';
    add(cash ? refunds.cash : refunds.nonCash, count, amount);
    add(refunds.total, count, amount);
    if (cash) {
      const entry = drawer(row.deviceId ?? null, row.deviceName ?? null);
      entry.amount = round2(entry.amount - amount);
    }
  }

  for (const row of input.pfandReturns) {
    if (row.isTest) continue;
    const amount = Math.abs(num(row.amount));
    add(pfandReturns, num(row.count), amount);
    const entry = drawer(row.deviceId ?? null, row.deviceName ?? null);
    entry.amount = round2(entry.amount - amount);
  }

  // Wertmarken: angenommen je Typ, verkauft, zurueckgetauscht. Bar
  // verkauft/zurueckgetauscht bewegt die Schublade des Geraets.
  const tokens = {
    received: zero(),
    receivedByType: [] as NonNullable<
      SettlementTotals['tokens']
    >['receivedByType'],
    sold: zero(),
    soldCash: 0,
    boughtBack: zero(),
  };
  for (const row of input.tokenRedemptions ?? []) {
    if (row.isTest) continue;
    const count = Math.round(num(row.count) * 1000) / 1000;
    const amount = round2(num(row.amount));
    tokens.received.count =
      Math.round((tokens.received.count + count) * 1000) / 1000;
    tokens.received.amount = round2(tokens.received.amount + amount);
    const existing = tokens.receivedByType.find(
      (t) => t.tokenTypeId === row.tokenTypeId,
    );
    if (existing) {
      existing.count = Math.round((existing.count + count) * 1000) / 1000;
      existing.amount = round2(existing.amount + amount);
    } else {
      tokens.receivedByType.push({
        tokenTypeId: row.tokenTypeId,
        name: row.name,
        unitValue: num(row.unitValue),
        count,
        amount,
      });
    }
  }
  let tokenCash = 0;
  for (const row of input.tokenTransactions ?? []) {
    if (row.isTest) continue;
    const count = Math.abs(num(row.count));
    const amount = Math.abs(num(row.amount));
    const cash = row.method === 'cash';
    if (row.kind === 'sale') {
      add(tokens.sold, count, amount);
      if (cash) tokens.soldCash = round2(tokens.soldCash + amount);
    } else {
      add(tokens.boughtBack, count, amount);
    }
    if (cash) {
      const signed = row.kind === 'sale' ? amount : -amount;
      tokenCash = round2(tokenCash + signed);
      const entry = drawer(row.deviceId ?? null, row.deviceName ?? null);
      entry.amount = round2(entry.amount + signed);
    }
  }
  const hasTokens =
    tokens.received.amount !== 0 ||
    tokens.sold.count !== 0 ||
    tokens.boughtBack.count !== 0;

  const taken = { orders: 0, items: 0, revenue: 0, discounts: 0 };
  for (const row of input.taken) {
    if (row.isTest) {
      training.orders += num(row.orders);
      continue;
    }
    taken.orders += num(row.orders);
    taken.discounts = round2(taken.discounts + num(row.discounts));
  }
  for (const row of input.items) {
    if (row.isTest) continue;
    taken.items += num(row.items);
    taken.revenue = round2(taken.revenue + num(row.revenue));
  }

  if (input.operatingMode === 'orders_only') {
    return {
      operatingMode: 'orders_only',
      taken: { orders: taken.orders, items: taken.items },
      training: { orders: training.orders, payments: training.payments },
    };
  }

  const cashExpected = round2(
    payments.cash.amount -
      refunds.cash.amount -
      pfandReturns.amount +
      tokenCash,
  );
  return {
    operatingMode: input.operatingMode,
    payments,
    tips,
    refunds,
    pfandReturns,
    ...(hasTokens ? { tokens } : {}),
    taken,
    cashExpected,
    cashByDevice: [...cashByDevice.values()]
      .filter((entry) => entry.amount !== 0)
      .sort((a, b) => b.amount - a.amount),
    training,
  };
}
