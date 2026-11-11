import type { Order } from '../../../database/entities/order.entity';
import {
  OrderItemStatus,
  type OrderItem,
} from '../../../database/entities/order-item.entity';
import type { Payment } from '../../../database/entities/payment.entity';
import { cents, rateRecord, tipByRate } from '../../refunds/refund-calc';
import {
  PROCESS_TYPE_ORDER,
  PROCESS_TYPE_OTHER,
  PROCESS_TYPE_RECEIPT,
  settlementProcessData,
  tipPayoutProcessData,
  abortProcessData,
  bestellungProcessData,
  cashbookProcessData,
  depositReturnSlots,
  emptySlots,
  kassenbelegProcessData,
  paymentTypeFor,
  slotsFromComposition,
} from '../../tse/tse-process-data';
import {
  fitSlots,
  paymentComposition,
  receiptLines,
} from '../../tse/tse-signing.service';
import { VAT_KEYS } from '../dsfinvk-builder';
import type {
  DsfinvkClosingInput,
  DsfinvkMasterData,
  DsfinvkReference,
  DsfinvkSettings,
  DsfinvkTransaction,
  DsfinvkTseUnit,
} from '../dsfinvk-types';

/**
 * Testdaten fuer den DSFinV-K-Generator. Die Prozessdaten und Kopien der
 * Positionen entstehen mit denselben Funktionen wie im Verkauf
 * (tse-process-data, tse-signing.service), damit die Tests echte Formen
 * pruefen.
 */

export const REGISTER_ID = 'OEOS-05E0C31E9B3A';

export const TSE_A: DsfinvkTseUnit = {
  id: '00000000-0000-4000-8000-00000000000a',
  serial: 'a1'.repeat(32),
  signatureAlgorithm: 'ecdsa-plain-SHA256',
  logTimeFormat: 'unixTime',
  publicKey:
    'BHhWOeisRpPBTGQ1W4VUH95TXx2GARf8e2NYZXJoInjtGqnxJ8sZ3CQpYgjI+LYEmW5A37sLWHsyU7nSJUBemyU=',
  certificate: 'MIIBszCCAVqgAwIBAgIUQ' + 'A'.repeat(1100),
};

export const TSE_B: DsfinvkTseUnit = {
  ...TSE_A,
  id: '00000000-0000-4000-8000-00000000000b',
  serial: 'b2'.repeat(32),
  certificate: '',
};

export const TERMINAL_1 = 'c0ffee00-0000-4000-8000-000000000001';
export const TERMINAL_2 = 'c0ffee00-0000-4000-8000-000000000002';

export function master(
  overrides: Partial<DsfinvkMasterData> = {},
): DsfinvkMasterData {
  return {
    company: {
      name: 'TSV Musterdorf e. V.',
      street: 'Sportplatzweg 1',
      zip: '12345',
      city: 'Musterdorf',
      country: 'DEU',
      taxNumber: '12/345/67890',
      vatId: '',
    },
    location: {
      name: 'TSV Musterdorf e. V.',
      street: 'Sportplatzweg 1',
      zip: '12345',
      city: 'Musterdorf',
      country: 'DEU',
      vatId: '',
    },
    register: {
      id: REGISTER_ID,
      brand: 'OpenEOS',
      model: 'OpenEOS Cloud-Kasse',
      softwareBrand: 'OpenEOS',
      softwareVersion: '1.7.0',
      baseCurrency: 'EUR',
    },
    terminals: [TERMINAL_1, TERMINAL_2].map((id, i) => ({
      id,
      brand: 'OpenEOS',
      model: 'Kasse (Browser)',
      serial: id,
      softwareBrand: 'OpenEOS',
      softwareVersion: '1.7.0',
      name: `Kasse ${i + 1}`,
    })),
    tseUnits: [TSE_A],
    vatKeys: VAT_KEYS,
    ...overrides,
  };
}

export const VAT_LIABLE: DsfinvkSettings = {
  vatExempt: false,
  tipRecipient: 'employer',
};
export const VAT_EXEMPT: DsfinvkSettings = {
  vatExempt: true,
  tipRecipient: 'employer',
};

/** Fortlaufende Bon-IDs und Zeiten fuer eine Testreihe. */
export class Sequence {
  bonId: number;
  time: number;
  constructor(firstBonId = 1, start = Date.parse('2026-11-03T15:00:00Z')) {
    this.bonId = firstBonId;
    this.time = start;
  }
  next(): { bonId: number; at: Date } {
    const at = new Date(this.time);
    this.time += 60_000;
    return { bonId: this.bonId++, at };
  }
}

let txCounter = 0;
let signatureCounter = 100;
let taNumber = 1;

function signed(
  seq: Sequence,
  unit: DsfinvkTseUnit,
  partial: Partial<DsfinvkTransaction> &
    Pick<DsfinvkTransaction, 'kind' | 'processType' | 'processData'>,
): DsfinvkTransaction {
  const { bonId, at } = seq.next();
  const training = partial.training ?? false;
  return {
    id: `tx-${++txCounter}`,
    bonId,
    training,
    status: training ? 'training' : 'signed',
    tseUnitId: unit.id,
    transactionNumber: taNumber++,
    signatureCounter: signatureCounter++,
    startTime: at,
    finishTime: new Date(at.getTime() + 300),
    signatureValue: 'MEUCIQ' + 'x'.repeat(80) + '==',
    errorCode: null,
    errorMessage: null,
    recovered: false,
    createdAt: at,
    endedAt: new Date(at.getTime() + 400),
    terminal: TERMINAL_1,
    userId: 'u-1',
    userName: 'Erika Helferin',
    lines: null,
    amountCents: null,
    orderId: null,
    orderNumber: null,
    tableNumber: null,
    originalAmountCents: null,
    references: [],
    ...partial,
  };
}

export interface ItemSpec {
  name: string;
  quantity: number;
  price: number;
  rate: number;
  deposit?: number;
  /** Satz des Pfands (ab 2026-11); fehlt = Bestand, nicht steuerbar. */
  depositRate?: number;
  options?: { group: string; option: string; priceModifier: number }[];
  category?: string;
}

function orderItems(specs: ItemSpec[]): OrderItem[] {
  return specs.map((s, i) => {
    const optionsPrice = (s.options ?? []).reduce(
      (sum, o) => sum + o.priceModifier,
      0,
    );
    return {
      id: `item-${i + 1}`,
      productId: `prod-${s.name.toLowerCase().replace(/\W+/g, '-')}`,
      categoryId: `cat-${(s.category ?? 'getraenke').toLowerCase()}`,
      categoryName: s.category ?? 'Getränke',
      productName: s.name,
      quantity: s.quantity,
      unitPrice: s.price,
      optionsPrice,
      taxRate: s.rate,
      totalPrice: Math.round((s.price + optionsPrice) * s.quantity * 100) / 100,
      depositAmount: s.deposit ?? 0,
      depositTaxRate: s.depositRate ?? null,
      status: OrderItemStatus.DELIVERED,
      options: { selected: s.options ?? [] },
    } as unknown as OrderItem;
  });
}

export interface SaleSpec {
  items: ItemSpec[];
  discount?: number;
  tip?: number;
  /** Servicegebuehr des Shops (eigene Leistung, `serviceFeeRate`, Standard 19 %). */
  serviceFee?: number;
  serviceFeeRate?: number;
  /**
   * Trinkgeld-Empfaenger wie `TseSigningService.signPayment` (ab
   * 2026-11-11): `employer` (Standard, TrinkgeldAG anteilig je Satz),
   * `employee` (Bedienung mit Arbeitnehmer-Flag, TrinkgeldAN, 0 %),
   * `legacy` (Bestand ohne Kennzeichen: 0-%-Slot, Organisations-Einstellung).
   */
  tipRecipient?: 'employer' | 'employee' | 'legacy';
  method?: string;
  training?: boolean;
  /** Teilbetrag statt Gesamtsumme (anteilige Zahlung). */
  amount?: number;
  /** Positionsweise Teilzahlung: Index der Position → Menge. */
  split?: { index: number; quantity: number }[];
  terminal?: string | null;
  orderNumber?: string;
  tableNumber?: string | null;
  orderId?: string;
  unit?: DsfinvkTseUnit;
  references?: DsfinvkReference[];
}

/** Kassenbeleg einer Zahlung, wie TseSigningService.signPayment ihn speichert. */
export function sale(
  seq: Sequence,
  settings: DsfinvkSettings,
  spec: SaleSpec,
): DsfinvkTransaction {
  const items = orderItems(spec.items);
  const subtotal = items.reduce(
    (s, i) => s + Number(i.totalPrice) + Number(i.depositAmount) * i.quantity,
    0,
  );
  const total =
    Math.round(
      (subtotal -
        (spec.discount ?? 0) +
        (spec.tip ?? 0) +
        (spec.serviceFee ?? 0)) *
        100,
    ) / 100;
  const order = {
    orderNumber: spec.orderNumber ?? '42',
    items,
    discountAmount: spec.discount ?? 0,
    tipAmount: spec.tip ?? 0,
    serviceFee: spec.serviceFee ?? 0,
    serviceFeeTaxRate: spec.serviceFee ? (spec.serviceFeeRate ?? 19) : null,
    total,
  } as unknown as Order;
  const metadata = spec.split
    ? {
        splitItems: spec.split.map((s) => ({
          orderItemId: items[s.index].id,
          quantity: s.quantity,
        })),
      }
    : {};
  let amount = spec.amount ?? total;
  if (spec.split) {
    amount =
      spec.split.reduce(
        (s, x) =>
          s +
          Math.round(
            (Number(items[x.index].unitPrice) +
              Number(items[x.index].optionsPrice)) *
              100,
          ) *
            x.quantity,
        0,
      ) / 100;
  }
  const payment = {
    paymentMethod: spec.method ?? 'cash',
    amount,
    metadata,
    itemPayments: [],
  } as unknown as Payment;
  const composition = paymentComposition(order, payment);
  const amountCents = cents(amount);
  const recipient = spec.tipRecipient ?? 'employer';
  const tipShares =
    composition.tip && recipient === 'employer' && !settings.vatExempt
      ? tipByRate(composition.goods, composition.tip)
      : null;
  const slots = fitSlots(
    slotsFromComposition(composition, settings.vatExempt, 1, tipShares),
    amountCents,
  );
  const processData = kassenbelegProcessData(
    spec.training ? 'AVTraining' : 'Beleg',
    {
      slots,
      payments: [
        { type: paymentTypeFor(payment.paymentMethod), cents: amountCents },
      ],
    },
  );
  return signed(seq, spec.unit ?? TSE_A, {
    kind: 'receipt',
    processType: PROCESS_TYPE_RECEIPT,
    processData,
    training: spec.training ?? false,
    amountCents,
    lines: {
      ...receiptLines(order, payment, composition),
      ...(recipient === 'legacy' ? {} : { tipRecipient: recipient }),
      ...(tipShares ? { tipByRate: rateRecord(tipShares) } : {}),
    },
    orderId: spec.orderId ?? `order-${spec.orderNumber ?? '42'}-0000-4000-8000`,
    orderNumber: spec.orderNumber ?? '42',
    tableNumber: spec.tableNumber ?? null,
    terminal: spec.terminal === undefined ? TERMINAL_1 : spec.terminal,
    references: spec.references ?? [],
  });
}

/** Beleg ueber 0,00 (voll rabattiert). */
export function zeroReceipt(
  seq: Sequence,
  spec: { items: ItemSpec[] },
): DsfinvkTransaction {
  const items = orderItems(spec.items);
  const discount = items.reduce((s, i) => s + Number(i.totalPrice), 0);
  return signed(seq, TSE_A, {
    kind: 'receipt',
    processType: PROCESS_TYPE_RECEIPT,
    processData: kassenbelegProcessData('Beleg', {
      slots: emptySlots(),
      payments: [],
    }),
    amountCents: 0,
    lines: {
      orderNumber: '7',
      zeroTotal: true,
      discount,
      items: items.map((i) => ({
        id: i.id,
        name: i.productName,
        quantity: i.quantity,
        unitPrice: Number(i.unitPrice),
        taxRate: Number(i.taxRate),
        deposit: 0,
      })),
    },
    orderId: 'order-7',
    orderNumber: '7',
  });
}

export interface RefundSpec {
  original: DsfinvkTransaction;
  closing: { zNr: number; createdAt: Date };
  items?: {
    name: string;
    quantity: number;
    unitPrice: number;
    taxRate: number;
    amount: number;
    deposit?: number;
    depositRate?: number;
  }[];
  pfand?: number;
  /** Satz des Pfands ohne Position (`pfand`); fehlt = Bestand (0 %). */
  pfandRate?: number;
  tip?: number;
  /** Ohne Positionen: Betrag je Satz (Kulanz). */
  goods?: Record<string, number>;
  method?: string;
  kind?: 'cancellation' | 'refund';
}

/** Gegenbeleg einer Erstattung (TseSigningService.signRefund). */
export function refund(
  seq: Sequence,
  settings: DsfinvkSettings,
  spec: RefundSpec,
): DsfinvkTransaction {
  const goods = new Map<number, number>();
  for (const item of spec.items ?? []) {
    goods.set(
      item.taxRate,
      (goods.get(item.taxRate) ?? 0) + Math.abs(cents(item.amount)),
    );
  }
  for (const [rate, value] of Object.entries(spec.goods ?? {})) {
    goods.set(Number(rate), (goods.get(Number(rate)) ?? 0) + cents(value));
  }
  const depositFromItems = (spec.items ?? []).reduce(
    (s, i) => s + cents(i.deposit ?? 0) * i.quantity,
    0,
  );
  const pfand = new Map<number, number>();
  const addPfand = (rate: number, value: number) => {
    if (value) pfand.set(rate, (pfand.get(rate) ?? 0) + value);
  };
  for (const i of spec.items ?? []) {
    addPfand(i.depositRate ?? 0, cents(i.deposit ?? 0) * i.quantity);
  }
  addPfand(spec.pfandRate ?? 0, cents(spec.pfand ?? 0));
  const withRates =
    spec.pfandRate !== undefined ||
    (spec.items ?? []).some((i) => i.depositRate !== undefined);
  const composition = { goods, pfand, tip: cents(spec.tip ?? 0) };
  const amountCents = -(
    [...goods.values()].reduce((a, b) => a + b, 0) +
    [...pfand.values()].reduce((a, b) => a + b, 0) +
    composition.tip
  );
  const slots = fitSlots(
    slotsFromComposition(composition, settings.vatExempt, -1),
    amountCents,
  );
  const method = spec.method ?? 'cash';
  return signed(seq, TSE_A, {
    kind: 'refund',
    processType: PROCESS_TYPE_RECEIPT,
    processData: kassenbelegProcessData('Beleg', {
      slots,
      payments: [{ type: paymentTypeFor(method), cents: amountCents }],
    }),
    amountCents,
    lines: {
      refundNumber: 'R-1',
      refundKind: spec.kind ?? 'cancellation',
      storno: true,
      items: (spec.items ?? []).map((i) => ({
        name: i.name,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        taxRate: i.taxRate,
        amount: -Math.abs(i.amount),
        deposit: i.deposit ?? 0,
        ...(i.depositRate !== undefined
          ? { depositTaxRate: i.depositRate }
          : {}),
      })),
      pfand: -(spec.pfand ?? 0) - depositFromItems / 100,
      ...(withRates
        ? {
            pfandByRate: Object.fromEntries(
              [...pfand.entries()].map(([r, v]) => [String(r), v]),
            ),
          }
        : {}),
      tip: -(spec.tip ?? 0),
      paymentMethod: method,
    },
    orderId: spec.original.orderId,
    orderNumber: spec.original.orderNumber,
    originalAmountCents: spec.original.amountCents,
    references: [
      {
        zNr: spec.closing.zNr,
        closingCreatedAt: spec.closing.createdAt,
        registerId: REGISTER_ID,
        bonId: spec.original.bonId,
      },
    ],
  });
}

/** Pfand-Auszahlung (TseSigningService.signPfandReturn). */
export function pfandReturn(
  seq: Sequence,
  lines: {
    name: string;
    unitAmount: number;
    quantity: number;
    /** Satz der Pfandart (ab 2026-11); fehlt = Bestand, 0-%-Slot. */
    vatRate?: number;
    /** Anteil gegen den Pfand-Altsaldo (Cent, ohne Steuerminderung). */
    legacyCents?: number;
  }[],
  terminal = TERMINAL_2,
  vatExempt = false,
): DsfinvkTransaction {
  const amountCents = -lines.reduce(
    (s, l) => s + cents(l.unitAmount) * l.quantity,
    0,
  );
  const slots = depositReturnSlots(lines, vatExempt);
  return signed(seq, TSE_A, {
    kind: 'deposit_return',
    processType: PROCESS_TYPE_RECEIPT,
    processData: kassenbelegProcessData('Beleg', {
      slots,
      payments: [{ type: 'Bar', cents: amountCents }],
    }),
    amountCents,
    lines: { pfandLines: lines.map((l) => ({ pfandTypeId: 'pt-1', ...l })) },
    terminal,
  });
}

/** Bestellvorgang im Tischbetrieb (Bestellung-V1). */
export function tableOrder(
  seq: Sequence,
  spec: {
    items: { name: string; quantity: number; price: number; rate: number }[];
    orderNumber: string;
    orderId: string;
    tableNumber: string;
    cancellation?: boolean;
    training?: boolean;
    references?: DsfinvkReference[];
  },
): DsfinvkTransaction {
  const lines = spec.items.map((i) => ({
    quantity: i.quantity,
    name: i.name,
    unitCents: cents(i.price),
    taxRate: i.rate,
  }));
  return signed(seq, TSE_A, {
    kind: spec.cancellation ? 'order_cancellation' : 'order',
    processType: PROCESS_TYPE_ORDER,
    processData: bestellungProcessData(lines),
    training: spec.training ?? false,
    amountCents: lines.reduce((s, l) => s + l.quantity * l.unitCents, 0),
    lines: {
      orderNumber: spec.orderNumber,
      tableNumber: spec.tableNumber,
      items: lines,
    },
    orderId: spec.orderId,
    orderNumber: spec.orderNumber,
    tableNumber: spec.tableNumber,
    references: spec.references ?? [],
  });
}

/** Kassenbuch-Buchung (Anfangsbestand, Einlage, Entnahme, Kassensturz-Differenz). */
export function cashbook(
  seq: Sequence,
  type: 'opening_balance' | 'deposit' | 'withdrawal' | 'cash_count',
  amountCents: number,
  note = '',
  terminal = TERMINAL_1,
): DsfinvkTransaction {
  return signed(seq, TSE_A, {
    kind: 'cashbook',
    processType: PROCESS_TYPE_RECEIPT,
    processData: cashbookProcessData(amountCents),
    amountCents,
    lines: { cashbookType: type, amountCents, note },
    terminal,
  });
}

/** Kellnerabrechnung (SonstigerVorgang, TseSigningService.signSettlement). */
export function settlement(
  seq: Sequence,
  spec: {
    number: number;
    name: string;
    expected: number;
    counted: number | null;
  },
): DsfinvkTransaction {
  const difference =
    spec.counted === null
      ? null
      : Math.round((spec.counted - spec.expected) * 100) / 100;
  const c = (v: number | null) => (v === null ? null : cents(v));
  return signed(seq, TSE_A, {
    kind: 'settlement',
    processType: PROCESS_TYPE_OTHER,
    processData: settlementProcessData({
      number: spec.number,
      expectedCents: c(spec.expected),
      countedCents: c(spec.counted),
      differenceCents: c(difference),
    }),
    amountCents: 0,
    lines: {
      settlementId: `s-${spec.number}`,
      settlementNumber: spec.number,
      subjectName: spec.name,
      expected: spec.expected,
      counted: spec.counted,
      difference,
    },
  });
}

/** Barauszahlung von Kartentrinkgeld (TseSigningService.signTipPayout). */
export function tipPayout(
  seq: Sequence,
  spec: { amount: number; name: string; waiterId: string },
): DsfinvkTransaction {
  const amountCents = -cents(spec.amount);
  return signed(seq, TSE_A, {
    kind: 'tip_payout',
    processType: PROCESS_TYPE_RECEIPT,
    processData: tipPayoutProcessData(amountCents),
    amountCents,
    lines: {
      tipPayoutId: 'tp-1',
      amountCents,
      recipientWaiterId: spec.waiterId,
      recipientName: spec.name,
    },
  });
}

/** Vorgang bei TSE-Ausfall: Zeitueberschreitung beim Abschluss. */
export function failed(
  tx: DsfinvkTransaction,
  withStart = true,
): DsfinvkTransaction {
  return {
    ...tx,
    status: 'failed',
    transactionNumber: withStart ? tx.transactionNumber : null,
    signatureCounter: null,
    finishTime: null,
    startTime: withStart ? tx.startTime : null,
    signatureValue: null,
    errorCode: 'E_TIMEOUT',
    errorMessage: 'finishTransaction timed out after 5000 ms',
  };
}

/**
 * Signatur nach Belegausgabe: der Bon wurde ohne Signatur gedruckt
 * (Zeitlimit), der Abgleich fand die Signatur spaeter. Status bleibt
 * `failed`, die Signaturdaten sind gespeichert (`recovered`).
 */
export function lateSigned(tx: DsfinvkTransaction): DsfinvkTransaction {
  return {
    ...tx,
    status: 'failed',
    recovered: true,
    errorCode: 'E_TIMEOUT',
    errorMessage: 'finishTransaction timed out after 5000 ms',
  };
}

/** AVBelegabbruch, mit dem der Abgleich die haengende Transaktion schliesst. */
export function abort(
  seq: Sequence,
  original: DsfinvkTransaction,
  closing: { zNr: number; createdAt: Date },
): DsfinvkTransaction {
  const tx = signed(seq, TSE_A, {
    kind: 'abort',
    processType: PROCESS_TYPE_RECEIPT,
    processData: abortProcessData(),
    amountCents: 0,
    lines: { reason: 'dangling transaction closed (AVBelegabbruch)' },
    terminal: null,
    userId: null,
    userName: null,
    orderId: original.orderId,
    orderNumber: original.orderNumber,
    references: [
      {
        zNr: closing.zNr,
        closingCreatedAt: closing.createdAt,
        registerId: REGISTER_ID,
        bonId: original.bonId,
      },
    ],
  });
  return {
    ...tx,
    transactionNumber: original.transactionNumber,
    startTime: original.startTime,
  };
}

export function closingInput(
  zNr: number,
  createdAt: Date,
  transactions: DsfinvkTransaction[],
  options: {
    settings?: DsfinvkSettings;
    master?: DsfinvkMasterData;
    businessDate?: string;
  } = {},
): DsfinvkClosingInput {
  return {
    zNr,
    createdAt,
    businessDate: options.businessDate ?? '2026-11-03',
    master: options.master ?? master(),
    settings: options.settings ?? VAT_LIABLE,
    transactions,
  };
}
