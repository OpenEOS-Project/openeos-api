import {
  cleanText,
  formatAmount,
  formatInteger,
  formatQuantity,
  formatRate,
  isoUtcMillis,
  makeRow,
  rfc3339Berlin,
  type CsvRow,
} from './dsfinvk-format';
import { parseBestellung, parseKassenbeleg } from './dsfinvk-process-data';
import { DSFINVK_VERSION, TABLE_NAMES, type TableName } from './dsfinvk-schema';
import type {
  BuiltClosing,
  ClosingTotals,
  DsfinvkClosingInput,
  DsfinvkRows,
  DsfinvkTransaction,
  DsfinvkVatKey,
} from './dsfinvk-types';

/**
 * Baut die Zeilen aller 20 DSFinV-K-Tabellen fuer **einen**
 * Kassenabschluss (rein, deterministisch). Grundsaetze:
 *
 * - Ein Vorgang = ein Datensatz aus `tse_transactions` = ein Bonkopf.
 * - Bonkopf_USt und Bonkopf_Zahlarten kommen aus den an die TSE
 *   uebergebenen Prozessdaten (die signierten, gedruckten Betraege);
 *   die Positionen (Bonpos) werden je USt-Schluessel exakt darauf
 *   abgestimmt (Rabatt-/Aufschlagszeilen fuer Rabatte und Rundung).
 * - Kassenabschluss (Z_GV_Typ, Z_Zahlart, Z_Waehrungen, Summen in
 *   Stamm_Abschluss) nur aus Vorgaengen mit BON_TYP „Beleg“ (Tz. 4.1).
 * - TERMINAL_ID im Bonkopf bleibt leer: die TSE kennt nur die eine Kasse
 *   (Client-ID = Z_KASSE_ID), nicht das Eingabegeraet (Anhang E,
 *   TERMINAL_ID). Das Geraet steht je Position in POS_TERMINAL_ID.
 */

/** USt-Schluessel nach Anlage 2 (Stand 05.12.2024), die OpenEOS nutzt. */
export const VAT_KEYS: DsfinvkVatKey[] = [
  {
    key: 1,
    rate: 19,
    description: 'Allgemeiner Steuersatz (§ 12 Abs. 1 UStG)',
  },
  { key: 2, rate: 7, description: 'Ermäßigter Steuersatz (§ 12 Abs. 2 UStG)' },
  { key: 5, rate: 0, description: 'Nicht steuerbar' },
  // Kleinunternehmer: Umsatz ist steuerfrei (§ 19 Abs. 1 UStG n. F.), also
  // steuerbar → Schluessel 6, nicht 5 (Steuerberater 2026-11-10, Frage 9).
  { key: 6, rate: 0, description: 'steuerfrei – Kleinunternehmer § 19 UStG' },
];

const KEY_RATE: Record<number, number> = { 1: 19, 2: 7, 3: 10.7, 4: 5.5 };
const SLOT_KEYS = [1, 2, 3, 4] as const;

export const BON_TYPES = [
  'Beleg',
  'AVTransfer',
  'AVBestellung',
  'AVTraining',
  'AVBelegstorno',
  'AVBelegabbruch',
  'AVSachbezug',
  'AVSonstige',
  'AVRechnung',
] as const;

export const GV_TYPES = [
  'Umsatz',
  'Pfand',
  'PfandRueckzahlung',
  'Rabatt',
  'Aufschlag',
  'ZuschussEcht',
  'ZuschussUnecht',
  'TrinkgeldAG',
  'TrinkgeldAN',
  'EinzweckgutscheinKauf',
  'EinzweckgutscheinEinloesung',
  'MehrzweckgutscheinKauf',
  'MehrzweckgutscheinEinloesung',
  'Forderungsentstehung',
  'Forderungsaufloesung',
  'Anzahlungseinstellung',
  'Anzahlungsaufloesung',
  'Anfangsbestand',
  'Privatentnahme',
  'Privateinlage',
  'Geldtransit',
  'Lohnzahlung',
  'Einzahlung',
  'Auszahlung',
  'DifferenzSollIst',
] as const;

export const PAYMENT_TYPES = [
  'Bar',
  'Unbar',
  'Keine',
  'ECKarte',
  'Kreditkarte',
  'ElZahlungsdienstleister',
  'Guthabenkarte',
] as const;

export const BRAND = 'OpenEOS';

/** `TSE_TA_FEHLER`/`BON_NOTIZ` fuer Signaturen, die erst nach dem Beleg kamen. */
export const LATE_SIGNATURE_NOTE = 'Signatur nach Belegausgabe';

export function rateKey(
  rate: number,
  vatExempt: boolean,
  zeroKey: number,
): number {
  if (vatExempt) return 6;
  const r = Math.round(Number(rate) * 100) / 100;
  if (r === 19) return 1;
  if (r === 7) return 2;
  if (r === 10.7) return 3;
  if (r === 5.5) return 4;
  return zeroKey;
}

export function keyRate(key: number): number {
  return KEY_RATE[key] ?? 0;
}

/** Enthaltene USt eines Bruttobetrags (wie auf dem Bon: brutto × Satz / (100 + Satz)). */
export function vatOf(grossCents: number, key: number): number {
  const rate = keyRate(key);
  if (!rate) return 0;
  const sign = grossCents < 0 ? -1 : 1;
  return sign * Math.round((Math.abs(grossCents) * rate) / (100 + rate));
}

/** Preis mit 2–5 Nachkommastellen (STK_BR ist N5), Dezimalkomma. */
export function formatPrice(cents: number): string {
  const scaled = Math.round(cents * 1000); // 1/100000 EUR
  const sign = scaled < 0 ? '-' : '';
  const abs = Math.abs(scaled);
  const whole = Math.floor(abs / 100000);
  let fraction = String(abs % 100000).padStart(5, '0');
  while (fraction.length > 2 && fraction.endsWith('0'))
    fraction = fraction.slice(0, -1);
  return `${sign}${whole},${fraction}`;
}

const cents = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const str = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const arr = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? (value.filter((v) => v && typeof v === 'object') as Record<
        string,
        unknown
      >[])
    : [];

// ------------------------------------------------------------ Entwuerfe

interface SubDraft {
  name: string;
  quantity: number;
  key: number;
  grossCents: number;
  artNr?: string;
}

interface PriceDraft {
  type: 'base_amount' | 'discount' | 'extra_amount';
  key: number;
  grossCents: number;
}

interface LineDraft {
  text: string;
  gvTyp: (typeof GV_TYPES)[number];
  gvName?: string;
  key: number;
  grossCents: number;
  quantity: number;
  /** Stueckpreis brutto in Cent (darf Bruchteile haben). */
  unitCents: number;
  artNr?: string;
  warengrId?: string;
  warengr?: string;
  sub?: SubDraft[];
  price?: PriceDraft[];
}

interface PaymentDraft {
  type: (typeof PAYMENT_TYPES)[number];
  name: string;
  cents: number;
}

interface BonDraft {
  tx: DsfinvkTransaction;
  bonTyp: (typeof BON_TYPES)[number];
  bonName: string;
  storno: boolean;
  vat: Map<number, number>;
  payments: PaymentDraft[];
  lines: LineDraft[];
  note: string;
  abrKreis: string | null;
  /** Empfaenger (KUNDE_NAME/KUNDE_ID), z. B. Trinkgeld-Auszahlung. */
  customer?: { name: string; id: string; type: string } | null;
}

interface Ctx {
  settings: DsfinvkClosingInput['settings'];
  /** Schluessel fuer den 0-%-Slot (Pfand, Trinkgeld, 0-%-Ware). */
  zeroKey: number;
}

/** Zahlart laut Anhang D aus Bar/Unbar der TSE und der Zahlart der Zahlung. */
export function paymentDraft(
  tseType: 'Bar' | 'Unbar',
  method: string | null | undefined,
  amountCents: number,
): PaymentDraft {
  if (tseType === 'Bar')
    return { type: 'Bar', name: 'Bargeld', cents: amountCents };
  switch (method) {
    case 'paypal':
      return {
        type: 'ElZahlungsdienstleister',
        name: 'PayPal',
        cents: amountCents,
      };
    case 'sumup_online':
      return {
        type: 'ElZahlungsdienstleister',
        name: 'SumUp Online',
        cents: amountCents,
      };
    case 'google_pay':
      return {
        type: 'ElZahlungsdienstleister',
        name: 'Google Pay',
        cents: amountCents,
      };
    case 'apple_pay':
      return {
        type: 'ElZahlungsdienstleister',
        name: 'Apple Pay',
        cents: amountCents,
      };
    case 'card':
    case 'sumup_terminal':
      // Debit oder Kredit ist nicht bekannt → zusammenfassend „Unbar“.
      return { type: 'Unbar', name: 'Kartenzahlung', cents: amountCents };
    default:
      return { type: 'Unbar', name: 'Unbar', cents: amountCents };
  }
}

const TIP_GV = (ctx: Ctx) =>
  ctx.settings.tipRecipient === 'employee' ? 'TrinkgeldAN' : 'TrinkgeldAG';

function orderLabel(tx: DsfinvkTransaction): string {
  return tx.orderNumber ? `Bestellung ${tx.orderNumber}` : 'Bestellung';
}

interface ItemSnapshot {
  id: string;
  name: string;
  quantity: number;
  unitCents: number;
  rate: number;
  depositCents: number;
  /** Satz des Pfands; null = nicht steuerbar (Bestand von vor 2026-11). */
  depositRate: number | null;
  productId: string;
  categoryId: string;
  categoryName: string;
  options: { name: string; cents: number }[];
}

function itemSnapshot(raw: Record<string, unknown>): ItemSnapshot {
  return {
    id: str(raw.id),
    name: str(raw.name) || 'Artikel',
    quantity: num(raw.quantity),
    unitCents: cents(raw.unitPrice),
    rate: num(raw.taxRate),
    depositCents: cents(raw.deposit),
    depositRate: optionalRate(raw.depositTaxRate),
    productId: str(raw.productId),
    categoryId: str(raw.categoryId),
    categoryName: str(raw.categoryName),
    options: arr(raw.options).map((o) => ({
      name: [str(o.group), str(o.option)].filter(Boolean).join(': '),
      cents: cents(o.priceModifier),
    })),
  };
}

/**
 * Servicegebuehr des Shops (TSE-Kopie `serviceFee`, ab 2026-11): eigene
 * Position `Umsatz` mit ihrem Satz. Aeltere Kopien haben sie nicht — dort
 * steckt die Gebuehr wie signiert im groessten Satz.
 */
function serviceFeeLine(
  s: Record<string, unknown>,
  ctx: Ctx,
): LineDraft | null {
  const raw = s.serviceFee as
    | { amount?: unknown; taxRate?: unknown }
    | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const gross = cents(raw.amount);
  if (!gross) return null;
  return {
    text: 'Servicegebühr',
    gvTyp: 'Umsatz',
    key: rateKey(num(raw.taxRate), ctx.settings.vatExempt, ctx.zeroKey),
    grossCents: gross,
    quantity: 1,
    unitCents: gross,
  };
}

function itemLine(item: ItemSnapshot, quantity: number, ctx: Ctx): LineDraft {
  const key = rateKey(item.rate, ctx.settings.vatExempt, ctx.zeroKey);
  return {
    text: item.name,
    gvTyp: 'Umsatz',
    key,
    grossCents: Math.round(quantity * item.unitCents),
    quantity,
    unitCents: item.unitCents,
    artNr: item.productId || undefined,
    warengrId: item.categoryId || undefined,
    warengr: item.categoryName || undefined,
    sub: item.options.length
      ? item.options.map((o) => ({
          name: o.name,
          quantity,
          key,
          grossCents: o.cents,
        }))
      : undefined,
  };
}

/** Satz aus der TSE-Kopie; fehlt er, ist es Bestand (nicht steuerbar). */
function optionalRate(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const rate = Number(value);
  return Number.isFinite(rate) ? rate : null;
}

/**
 * USt-Schluessel fuer Pfand: Satz der Pfandart (Pfand ist Teil des
 * Entgelts), ohne Satz (Bestand) der 0-%-Schluessel wie damals in der TSE.
 */
function depositKey(rate: number | null, ctx: Ctx): number {
  if (rate === null) return ctx.zeroKey;
  return rateKey(rate, ctx.settings.vatExempt, ctx.zeroKey);
}

function depositLine(
  item: ItemSnapshot,
  quantity: number,
  ctx: Ctx,
): LineDraft | null {
  if (!item.depositCents) return null;
  return {
    text: `Pfand ${item.name}`,
    gvTyp: 'Pfand',
    key: depositKey(item.depositRate, ctx),
    grossCents: Math.round(quantity * item.depositCents),
    quantity,
    unitCents: item.depositCents,
  };
}

/**
 * Trinkgeld-Zeilen eines Vorgangs (Steuerberater 2026-11-10, Fragen 3–5):
 * - `tipRecipient: 'employee'` (Bedienung mit „Arbeitnehmer (Lohnkonto)“):
 *   `TrinkgeldAN`, kein Entgelt → Schluessel 5.
 * - `tipByRate` (Trinkgeld an den umsatzsteuerpflichtigen Verein):
 *   `TrinkgeldAG` je Satz der Hauptleistung, anteilig wie signiert.
 * - Steuerbefreit (Kleinunternehmer): `TrinkgeldAG` mit Schluessel 6.
 * - Bestand ohne Kennzeichen (vor 2026-11-11): wie damals signiert im
 *   0-%-Slot, GV_TYP nach der alten Organisations-Einstellung.
 * `tipCents` mit Vorzeichen (Erstattung negativ).
 */
function tipLines(
  s: Record<string, unknown>,
  tipCents: number,
  ctx: Ctx,
): LineDraft[] {
  if (!tipCents) return [];
  const line = (gvTyp: LineDraft['gvTyp'], key: number, gross: number) => ({
    text: 'Trinkgeld',
    gvTyp,
    key,
    grossCents: gross,
    quantity: gross < 0 ? -1 : 1,
    unitCents: Math.abs(gross),
  });
  if (str(s.tipRecipient) === 'employee') {
    return [line('TrinkgeldAN', 5, tipCents)];
  }
  const byRate = s.tipByRate as Record<string, unknown> | undefined;
  if (
    str(s.tipRecipient) === 'employer' &&
    !ctx.settings.vatExempt &&
    byRate &&
    typeof byRate === 'object' &&
    Object.keys(byRate).length > 0
  ) {
    const weights = Object.entries(byRate).map(
      ([rate, value]) => [Number(rate), Math.abs(num(value))] as const,
    );
    return proportional(weights, tipCents).map(([rate, gross]) =>
      line('TrinkgeldAG', rateKey(rate, false, ctx.zeroKey), gross),
    );
  }
  if (str(s.tipRecipient) === 'employer') {
    return [line('TrinkgeldAG', ctx.zeroKey, tipCents)];
  }
  return [line(TIP_GV(ctx), ctx.zeroKey, tipCents)];
}

/** `total` (Cent, mit Vorzeichen) im Verhaeltnis der Gewichte, Rest auf das groesste. */
function proportional(
  weights: ReadonlyArray<readonly [number, number]>,
  total: number,
): [number, number][] {
  const sum = weights.reduce((a, [, w]) => a + w, 0);
  if (sum <= 0 || weights.length === 0) return [[19, total]];
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  let assigned = 0;
  let largest = 0;
  const out = weights.map(([rate, w], index) => {
    if (w > weights[largest][1]) largest = index;
    const share = Math.floor((abs * w) / sum);
    assigned += share;
    return [rate, share] as [number, number];
  });
  out[largest][1] += abs - assigned;
  return out
    .filter(([, v]) => v !== 0)
    .map(([rate, v]) => [rate, sign * v] as [number, number]);
}

/**
 * Der 0-%-Slot der Prozessdaten gilt fuer die Schluessel 5, 6 und 7
 * gemeinsam. Stehen auf einem Bon Zeilen mit verschiedenen dieser
 * Schluessel (z. B. Kleinunternehmer mit TrinkgeldAN oder steuerpflichtig
 * mit Pfand-Altsaldo), wird der Slot im Bonkopf nach den Zeilen aufgeteilt.
 */
function splitZeroSlot(bon: BonDraft, zeroKey: number): void {
  const slot = bon.vat.get(zeroKey);
  if (slot === undefined) return;
  let moved = 0;
  for (const key of [5, 6, 7]) {
    if (key === zeroKey) continue;
    const sum = bon.lines
      .filter((l) => l.key === key)
      .reduce((a, l) => a + l.grossCents, 0);
    if (!sum) continue;
    bon.vat.set(key, (bon.vat.get(key) ?? 0) + sum);
    moved += sum;
  }
  if (!moved) return;
  const rest = slot - moved;
  if (rest) bon.vat.set(zeroKey, rest);
  else bon.vat.delete(zeroKey);
}

// ------------------------------------------------- Positionen je Vorgang

function receiptLines(
  tx: DsfinvkTransaction,
  ctx: Ctx,
  vat: Map<number, number>,
): LineDraft[] {
  const s = tx.lines ?? {};
  const items = arr(s.items).map(itemSnapshot);
  const amount = tx.amountCents ?? cents(s.amount);
  const discount = cents(s.discount);
  const tip = cents(s.tip);
  const composition = (s.composition ?? {}) as {
    goods?: Record<string, number>;
    pfand?: number;
    pfandByRate?: Record<string, number>;
    tip?: number;
  };

  if (s.zeroTotal === true && items.length === 0) {
    return [
      {
        text: `${orderLabel(tx)} (vollständig rabattiert)`,
        gvTyp: 'Umsatz',
        key: ctx.zeroKey,
        grossCents: 0,
        quantity: 1,
        unitCents: 0,
      },
    ];
  }

  // Teilzahlung nach Positionen (Split an der Kasse).
  const split = arr(s.splitItems);
  if (split.length > 0 && items.every((i) => i.id)) {
    const lines: LineDraft[] = [];
    for (const entry of split) {
      const item = items.find((i) => i.id === str(entry.orderItemId));
      if (!item) continue;
      lines.push(itemLine(item, num(entry.quantity), ctx));
    }
    if (lines.length > 0) return lines;
  }

  const fee = serviceFeeLine(s, ctx);
  const fullTotal =
    items.reduce(
      (sum, i) => sum + Math.round(i.quantity * (i.unitCents + i.depositCents)),
      0,
    ) -
    discount +
    tip +
    (fee?.grossCents ?? 0);
  if (
    items.length > 0 &&
    (Math.abs(fullTotal - amount) <= 1 || s.zeroTotal === true)
  ) {
    const lines: LineDraft[] = [];
    for (const item of items) {
      lines.push(itemLine(item, item.quantity, ctx));
      const deposit = depositLine(item, item.quantity, ctx);
      if (deposit) lines.push(deposit);
    }
    if (fee) lines.push(fee);
    lines.push(...tipLines(s, tip, ctx));
    // Rabatt je USt-Schluessel ergibt sich beim Abstimmen (reconcile).
    return lines;
  }

  // Teilbetrag einer Bestellung (anteilig): je Satz eine Zeile, die
  // Positionen der Bestellung zur Erlaeuterung in Bonpos_Zusatzinfo.
  const lines: LineDraft[] = [];
  const goods = composition.goods ?? {};
  // Pfand je Satz (ab 2026-11); aeltere Kopien nur gesamt = nicht steuerbar.
  const pfandParts: [number | null, number][] = composition.pfandByRate
    ? Object.entries(composition.pfandByRate).map(([rate, value]) => [
        Number(rate),
        Math.round(num(value)),
      ])
    : [[null, Math.round(num(composition.pfand))]];
  const compTip = num(composition.tip);
  for (const [rate, value] of Object.entries(goods)) {
    const gross = Math.round(num(value));
    if (!gross) continue;
    const key = rateKey(Number(rate), ctx.settings.vatExempt, ctx.zeroKey);
    lines.push({
      text: `Teilzahlung ${orderLabel(tx)}`,
      gvTyp: 'Umsatz',
      key,
      grossCents: gross,
      quantity: 1,
      unitCents: gross,
    });
  }
  for (const [rate, pfand] of pfandParts) {
    if (!pfand) continue;
    lines.push({
      text: 'Pfand (anteilig)',
      gvTyp: 'Pfand',
      key: depositKey(rate, ctx),
      grossCents: pfand,
      quantity: 1,
      unitCents: pfand,
    });
  }
  lines.push(...tipLines(s, Math.round(compTip), ctx));
  if (lines.length === 0) {
    for (const [key, gross] of vat) {
      lines.push({
        text: `Teilzahlung ${orderLabel(tx)}`,
        gvTyp: 'Umsatz',
        key,
        grossCents: gross,
        quantity: 1,
        unitCents: gross,
      });
    }
  }
  if (lines.length > 0 && items.length > 0) {
    lines[0].sub = items.map((i) => ({
      name: i.name,
      quantity: i.quantity,
      key: rateKey(i.rate, ctx.settings.vatExempt, ctx.zeroKey),
      grossCents: 0,
      artNr: i.productId || undefined,
    }));
  }
  return lines;
}

function refundLines(tx: DsfinvkTransaction, ctx: Ctx): LineDraft[] {
  const s = tx.lines ?? {};
  const lines: LineDraft[] = [];
  for (const raw of arr(s.items)) {
    const quantity = -Math.abs(num(raw.quantity));
    const unit = cents(raw.unitPrice);
    const gross = -Math.abs(cents(raw.amount));
    const key = rateKey(num(raw.taxRate), ctx.settings.vatExempt, ctx.zeroKey);
    const base = Math.round(quantity * unit);
    const line: LineDraft = {
      text: str(raw.name) || 'Artikel',
      gvTyp: 'Umsatz',
      key,
      grossCents: gross,
      quantity,
      unitCents: quantity ? gross / quantity : unit,
    };
    if (base !== gross) {
      // Erstattet wird der rabattierte Preis: Entstehung in Bonpos_Preisfindung.
      const diff = gross - base;
      line.price = [
        { type: 'base_amount', key, grossCents: base },
        { type: diff > 0 ? 'discount' : 'extra_amount', key, grossCents: diff },
      ];
    }
    lines.push(line);
    const deposit = cents(raw.deposit);
    if (deposit) {
      lines.push({
        text: `Pfand ${str(raw.name)}`.trim(),
        gvTyp: 'Pfand',
        key: depositKey(optionalRate(raw.depositTaxRate), ctx),
        grossCents: Math.round(quantity * deposit),
        quantity,
        unitCents: deposit,
      });
    }
  }
  // Pfand ohne Position (Erstattung nach Betrag): je Satz der Rest, den
  // die Positionen nicht schon zeigen. Aeltere Kopien kennen nur `pfand`.
  const pfandTargets = new Map<number, number>();
  const byRate = s.pfandByRate as Record<string, unknown> | undefined;
  if (byRate && typeof byRate === 'object') {
    for (const [rate, value] of Object.entries(byRate)) {
      const key = depositKey(Number(rate), ctx);
      pfandTargets.set(
        key,
        (pfandTargets.get(key) ?? 0) - Math.abs(Math.round(num(value))),
      );
    }
  } else {
    pfandTargets.set(ctx.zeroKey, -Math.abs(cents(s.pfand)));
  }
  // Positionen ohne passendes Ziel (Rundung) gleicht reconcile aus.
  for (const [key, target] of pfandTargets) {
    const shown = lines
      .filter((l) => l.gvTyp === 'Pfand' && l.key === key)
      .reduce((sum, l) => sum + l.grossCents, 0);
    const pfand = target - shown;
    if (!pfand) continue;
    lines.push({
      text: 'Pfand',
      gvTyp: 'Pfand',
      key,
      grossCents: pfand,
      quantity: -1,
      unitCents: -pfand,
    });
  }
  lines.push(...tipLines(s, -Math.abs(cents(s.tip)), ctx));
  return lines;
}

function depositReturnLines(tx: DsfinvkTransaction, ctx: Ctx): LineDraft[] {
  const s = tx.lines ?? {};
  return arr(s.pfandLines).flatMap((raw) => {
    const quantity = -Math.abs(num(raw.quantity));
    const unit = cents(raw.unitAmount);
    const gross = Math.round(quantity * unit);
    // Pfand-Altsaldo (Steuerberater 2026-11-10, Frage 2): der Anteil fuer
    // Becher, die vor der Umstellung ohne USt verkauft wurden, mindert keine
    // Steuer → eigene PfandRueckzahlung mit Schluessel 5 (steuerbefreit 6).
    const legacy = Math.min(
      Math.max(0, Math.round(num(raw.legacyCents))),
      Math.abs(gross),
    );
    const name = str(raw.name);
    const lines: LineDraft[] = [];
    if (legacy < Math.abs(gross)) {
      const rest = gross + legacy;
      lines.push({
        text: `Pfandrückgabe ${name}`.trim(),
        gvTyp: 'PfandRueckzahlung' as const,
        key: depositKey(optionalRate(raw.vatRate), ctx),
        grossCents: rest,
        quantity: legacy ? -1 : quantity,
        unitCents: legacy ? -rest : unit,
      });
    }
    if (legacy) {
      lines.push({
        text: `Pfandrückgabe ${name} (Altsaldo vor USt-Umstellung)`.trim(),
        gvTyp: 'PfandRueckzahlung' as const,
        key: ctx.zeroKey,
        grossCents: -legacy,
        quantity: -1,
        unitCents: legacy,
      });
    }
    return lines;
  });
}

export const CASHBOOK_LINES: Record<
  string,
  { gvTyp: LineDraft['gvTyp']; text: string; gvName: string }
> = {
  // Steuerberater 2026-11-10, Frage 6: Anfangsbestand nur fuer den
  // Restbestand aus dem Vorabschluss; Wechselgeld aus der Vereinskasse und
  // die Abschoepfung am Ende sind Geldtransit (Schluessel 5), keine
  // Privateinlage/-entnahme (der e. V. hat keine Privatsphaere).
  opening_balance: {
    gvTyp: 'Anfangsbestand',
    text: 'Anfangsbestand',
    gvName: 'Restbestand Vorabschluss',
  },
  deposit: {
    gvTyp: 'Geldtransit',
    text: 'Geldtransit',
    gvName: 'Wechselgeld aus Vereinskasse',
  },
  withdrawal: {
    gvTyp: 'Geldtransit',
    text: 'Geldtransit',
    gvName: 'Abschöpfung an Vereinskasse',
  },
  cash_count: {
    gvTyp: 'DifferenzSollIst',
    text: 'DifferenzSollIst',
    gvName: 'Kassensturz',
  },
};

function cashbookLines(
  tx: DsfinvkTransaction,
  vat: Map<number, number>,
): LineDraft[] {
  const s = tx.lines ?? {};
  const def = CASHBOOK_LINES[str(s.cashbookType)] ?? CASHBOOK_LINES.deposit;
  const amount =
    s.amountCents !== undefined
      ? Math.round(num(s.amountCents))
      : [...vat.values()].reduce((a, b) => a + b, 0);
  return [
    {
      text: def.text,
      gvTyp: def.gvTyp,
      gvName: def.gvName,
      key: 5,
      grossCents: amount,
      quantity: 1,
      unitCents: amount,
    },
  ];
}

function orderLines(tx: DsfinvkTransaction, ctx: Ctx): LineDraft[] {
  const s = tx.lines ?? {};
  let items = arr(s.items).map((raw) => ({
    quantity: num(raw.quantity),
    name: str(raw.name) || 'Artikel',
    unitCents: Math.round(num(raw.unitCents)),
    rate:
      raw.taxRate === undefined || raw.taxRate === null
        ? null
        : num(raw.taxRate),
  }));
  if (items.length === 0) {
    items = (parseBestellung(tx.processData) ?? []).map((l) => ({
      ...l,
      rate: null,
    }));
  }
  return items.map((item) => ({
    text: item.name,
    gvTyp: 'Umsatz' as const,
    key: rateKey(item.rate ?? 0, ctx.settings.vatExempt, ctx.zeroKey),
    grossCents: Math.round(item.quantity * item.unitCents),
    quantity: item.quantity,
    unitCents: item.unitCents,
  }));
}

/**
 * Stimmt die Positionen je USt-Schluessel exakt auf die Kopfbetraege ab.
 * Fehlbetraege (Rabatt auf die Bestellung, Rundung, anteilige Zahlung)
 * werden eigene Positionszeilen „Rabatt“ bzw. „Aufschlag“ mit korrekter
 * Steuerzuordnung (DSFinV-K Tz. 4.2.4).
 */
function reconcile(
  bon: BonDraft,
  hasDiscount: boolean,
  label?: { text: string; gvTyp: LineDraft['gvTyp'] },
): void {
  const total = [...bon.vat.values()].reduce((a, b) => a + b, 0);
  const keys = new Set<number>([
    ...bon.vat.keys(),
    ...bon.lines.map((l) => l.key),
  ]);
  for (const key of [...keys].sort((a, b) => a - b)) {
    const target = bon.vat.get(key) ?? 0;
    const current = bon.lines
      .filter((l) => l.key === key)
      .reduce((sum, l) => sum + l.grossCents, 0);
    const diff = target - current;
    if (diff === 0) continue;
    if (label) {
      bon.lines.push({
        text: label.text,
        gvTyp: label.gvTyp,
        key,
        grossCents: diff,
        quantity: 1,
        unitCents: diff,
      });
      continue;
    }
    const reduces = total >= 0 ? diff < 0 : diff > 0;
    const rounding =
      !hasDiscount && Math.abs(diff) <= Math.max(2, bon.lines.length);
    bon.lines.push({
      text: rounding ? 'Rundungsdifferenz' : reduces ? 'Rabatt' : 'Aufschlag',
      gvTyp: reduces ? 'Rabatt' : 'Aufschlag',
      gvName: rounding ? 'Rundung' : undefined,
      key,
      grossCents: diff,
      quantity: 1,
      unitCents: diff,
    });
  }
}

const BON_NAMES: Record<string, string> = {
  receipt: 'Verkauf',
  refund: 'Erstattung',
  deposit_return: 'Pfandrückgabe',
  order: 'Bestellung',
  order_cancellation: 'Bestellstorno',
  abort: 'Belegabbruch',
  cashbook: 'Kassenbuch',
  settlement: 'Kellnerabrechnung',
  tip_payout: 'Trinkgeld-Auszahlung',
};

function draftBon(
  tx: DsfinvkTransaction,
  settings: DsfinvkClosingInput['settings'],
): BonDraft {
  // Kassenbuch und TrinkgeldAN sind nie Umsatz → immer Schluessel 5.
  const zeroKey =
    tx.kind === 'cashbook' || tx.kind === 'tip_payout'
      ? 5
      : settings.vatExempt
        ? 6
        : 5;
  const ctx: Ctx = { settings, zeroKey };
  const isOrder = tx.processType === 'Bestellung-V1';
  const parsed = isOrder ? null : parseKassenbeleg(tx.processData);
  let bonTyp: BonDraft['bonTyp'];
  if (tx.kind === 'abort') bonTyp = 'AVBelegabbruch';
  else if (tx.training) bonTyp = 'AVTraining';
  // Kellnerabrechnung: anderer Vorgang ohne Geldbewegung (SonstigerVorgang).
  else if (tx.kind === 'settlement') bonTyp = 'AVSonstige';
  else if (isOrder) bonTyp = 'AVBestellung';
  else if (parsed && (BON_TYPES as readonly string[]).includes(parsed.type)) {
    bonTyp = parsed.type as BonDraft['bonTyp'];
  } else bonTyp = 'Beleg';

  const vat = new Map<number, number>();
  const payments: PaymentDraft[] = [];
  const method = str((tx.lines ?? {}).paymentMethod) || null;
  if (parsed) {
    parsed.slots.forEach((value, index) => {
      if (!value) return;
      const key = index < 4 ? SLOT_KEYS[index] : zeroKey;
      vat.set(key, (vat.get(key) ?? 0) + value);
    });
    for (const p of parsed.payments) {
      if (p.cents) payments.push(paymentDraft(p.type, method, p.cents));
    }
  }

  const bon: BonDraft = {
    tx,
    bonTyp,
    bonName: BON_NAMES[tx.kind] ?? '',
    storno:
      tx.kind === 'refund' &&
      tx.originalAmountCents !== null &&
      tx.amountCents !== null &&
      tx.originalAmountCents !== 0 &&
      tx.amountCents === -tx.originalAmountCents,
    vat,
    payments,
    lines: [],
    note: '',
    abrKreis: null,
  };

  const s = tx.lines ?? {};
  switch (tx.kind) {
    case 'receipt':
      bon.lines = receiptLines(tx, ctx, vat);
      splitZeroSlot(bon, zeroKey);
      reconcile(bon, cents(s.discount) !== 0);
      break;
    case 'refund': {
      bon.lines = refundLines(tx, ctx);
      splitZeroSlot(bon, zeroKey);
      const hasItems = arr(s.items).length > 0;
      reconcile(
        bon,
        true,
        hasItems
          ? undefined
          : str(s.refundKind) === 'cancellation'
            ? { text: 'Storno', gvTyp: 'Umsatz' }
            : { text: 'Erstattung (Kulanz)', gvTyp: 'Rabatt' },
      );
      break;
    }
    case 'deposit_return':
      bon.lines = depositReturnLines(tx, ctx);
      splitZeroSlot(bon, zeroKey);
      reconcile(bon, false, {
        text: 'Pfandrückgabe',
        gvTyp: 'PfandRueckzahlung',
      });
      break;
    case 'cashbook':
      bon.lines = cashbookLines(tx, vat);
      break;
    case 'order':
    case 'order_cancellation':
      bon.lines = orderLines(tx, ctx);
      // Bestellvorgaenge haben keine Steuer-Slots: Kopf aus den Positionen.
      for (const line of bon.lines)
        vat.set(line.key, (vat.get(line.key) ?? 0) + line.grossCents);
      break;
    case 'settlement':
      // Nur die abgesicherten Zahlen (BON_NOTIZ), keine Positionen.
      bon.lines = [];
      break;
    case 'tip_payout': {
      const amount = -Math.abs(
        Math.round(num(s.amountCents)) ||
          [...vat.values()].reduce((a, b) => a + b, 0),
      );
      bon.lines = [
        {
          text: 'Auszahlung Kartentrinkgeld',
          gvTyp: 'TrinkgeldAN',
          key: 5,
          grossCents: amount,
          quantity: -1,
          unitCents: -amount,
        },
      ];
      reconcile(bon, false, {
        text: 'Auszahlung Kartentrinkgeld',
        gvTyp: 'TrinkgeldAN',
      });
      bon.customer = {
        name: str(s.recipientName).slice(0, 50),
        id: str(s.recipientWaiterId).slice(0, 50),
        type: 'Mitarbeiter',
      };
      break;
    }
    case 'abort':
    default:
      break;
  }

  const total = [...vat.values()].reduce((a, b) => a + b, 0);
  if ((bonTyp !== 'Beleg' && bonTyp !== 'AVTraining') || isOrder) {
    // Andere Vorgaenge kennen nur die Zahlart „Keine“ (Anhang B).
    bon.payments = [{ type: 'Keine', name: 'Keine', cents: total }];
  } else if (bon.payments.length === 0 && total === 0) {
    bon.payments = [{ type: 'Bar', name: 'Bargeld', cents: 0 }];
  }

  const notes: string[] = [];
  if (tx.status === 'failed') notes.push('TSE ausgefallen');
  // Bestand: vor 2026-11 wurden spaet gefundene Signaturen als signiert
  // gefuehrt; seitdem bleibt der Vorgang `failed` (Ausfallbeleg).
  if (tx.recovered) notes.push(LATE_SIGNATURE_NOTE);
  if (tx.kind === 'cashbook' && s.note) notes.push(str(s.note));
  if (tx.kind === 'settlement') {
    const euro = (v: unknown) =>
      v === null || v === undefined || v === ''
        ? '–'
        : `${(Math.round(num(v) * 100) / 100).toFixed(2).replace('.', ',')} €`;
    notes.push(
      `Kellnerabrechnung${s.settlementNumber ? ` Nr. ${num(s.settlementNumber)}` : ''} ${str(s.subjectName)}: Soll ${euro(s.expected)}, Ist ${euro(s.counted)}, Differenz ${euro(s.difference)}`.replace(
        /\s+/g,
        ' ',
      ),
    );
  }
  if (tx.kind === 'tip_payout')
    notes.push(`Quittiert von ${str(s.recipientName)}`);
  if (tx.kind === 'refund' && s.refundNumber)
    notes.push(`Erstattung ${str(s.refundNumber)}`);
  bon.note = notes.join('; ');
  if (tx.orderId) {
    const table = tx.tableNumber ? `Tisch ${tx.tableNumber} / ` : '';
    bon.abrKreis = `${table}${orderLabel(tx)} (${tx.orderId.slice(0, 8)})`;
  }
  return bon;
}

// --------------------------------------------------------------- Zeilen

function emptyRows(): DsfinvkRows {
  return Object.fromEntries(
    TABLE_NAMES.map((name) => [name, [] as CsvRow[]]),
  ) as DsfinvkRows;
}

const GV_ORDER = new Map<string, number>(GV_TYPES.map((g, i) => [g, i]));
const PAYMENT_ORDER = new Map<string, number>(
  PAYMENT_TYPES.map((p, i) => [p, i]),
);

export function buildClosing(input: DsfinvkClosingInput): BuiltClosing {
  const rows = emptyRows();
  const { master, settings } = input;
  const zKasse = master.register.id;
  const zErstellung = rfc3339Berlin(input.createdAt);
  const key = {
    Z_KASSE_ID: zKasse,
    Z_ERSTELLUNG: zErstellung,
    Z_NR: formatInteger(input.zNr),
  };
  const add = (
    table: TableName,
    values: Record<string, string | null | undefined>,
  ) => rows[table].push(makeRow(table, { ...key, ...values }));

  const tseIndex = new Map(master.tseUnits.map((u, i) => [u.id, i + 1]));
  const transactions = [...input.transactions].sort(
    (a, b) => a.bonId - b.bonId,
  );
  const bons = transactions.map((tx) => draftBon(tx, settings));

  const gvSums = new Map<
    string,
    {
      gvTyp: string;
      gvName: string;
      vatKey: number;
      gross: number;
      net: number;
      vat: number;
    }
  >();
  const paySums = new Map<
    string,
    { type: string; name: string; cents: number }
  >();
  const vatSums = new Map<
    number,
    { gross: number; net: number; vat: number }
  >();
  const counts: ClosingTotals['counts'] = {
    transactions: bons.length,
    receipts: 0,
    training: 0,
    orders: 0,
    failed: 0,
    cancelled: 0,
  };
  let gross = 0;

  for (const bon of bons) {
    const { tx } = bon;
    const bonId = formatInteger(tx.bonId);
    const total = [...bon.vat.values()].reduce((a, b) => a + b, 0);
    const isBeleg = bon.bonTyp === 'Beleg';
    if (isBeleg) counts.receipts++;
    if (bon.bonTyp === 'AVTraining') counts.training++;
    if (bon.bonTyp === 'AVBestellung') counts.orders++;
    if (tx.status === 'failed') counts.failed++;
    if (bon.storno) counts.cancelled++;
    if (isBeleg) gross += total;

    add('Bonkopf', {
      BON_ID: bonId,
      BON_NR: bonId,
      BON_TYP: bon.bonTyp,
      BON_NAME: bon.bonName,
      TERMINAL_ID: '',
      BON_STORNO: bon.storno ? '1' : '0',
      BON_START: rfc3339Berlin(tx.createdAt),
      BON_ENDE: rfc3339Berlin(tx.endedAt),
      BEDIENER_ID: tx.userId ?? '',
      BEDIENER_NAME: tx.userName ?? '',
      UMS_BRUTTO: formatAmount(total),
      KUNDE_NAME: bon.customer?.name ?? '',
      KUNDE_ID: bon.customer?.id ?? '',
      KUNDE_TYP: bon.customer?.type ?? '',
      BON_NOTIZ: bon.note,
    });

    const headerKeys = new Set<number>([
      ...bon.vat.keys(),
      ...bon.lines.map((l) => l.key),
    ]);
    for (const vatKey of [...headerKeys].sort((a, b) => a - b)) {
      const g = bon.vat.get(vatKey) ?? 0;
      const v = vatOf(g, vatKey);
      add('Bonkopf_USt', {
        BON_ID: bonId,
        UST_SCHLUESSEL: formatInteger(vatKey),
        BON_BRUTTO: formatAmount(g),
        BON_NETTO: formatAmount(g - v),
        BON_UST: formatAmount(v),
      });
      if (isBeleg) {
        const sum = vatSums.get(vatKey) ?? { gross: 0, net: 0, vat: 0 };
        sum.gross += g;
        sum.net += g - v;
        sum.vat += v;
        vatSums.set(vatKey, sum);
      }
    }

    if (bon.abrKreis)
      add('Bonkopf_AbrKreis', {
        BON_ID: bonId,
        ABRECHNUNGSKREIS: bon.abrKreis,
      });

    const payments = new Map<string, PaymentDraft>();
    for (const p of bon.payments) {
      const k = `${p.type}|${p.name}`;
      const existing = payments.get(k);
      if (existing) existing.cents += p.cents;
      else payments.set(k, { ...p });
    }
    for (const p of payments.values()) {
      add('Bonkopf_Zahlarten', {
        BON_ID: bonId,
        ZAHLART_TYP: p.type,
        ZAHLART_NAME: p.name,
        ZAHLWAEH_CODE: '',
        ZAHLWAEH_BETRAG: '',
        BASISWAEH_BETRAG: formatAmount(p.cents),
      });
      if (isBeleg) {
        const k = `${p.type}|${p.name}`;
        const sum = paySums.get(k) ?? { type: p.type, name: p.name, cents: 0 };
        sum.cents += p.cents;
        paySums.set(k, sum);
      }
    }

    bon.lines.forEach((line, index) => {
      const posZeile = String(index + 1);
      add('Bonpos', {
        BON_ID: bonId,
        POS_ZEILE: posZeile,
        GUTSCHEIN_NR: '',
        ARTIKELTEXT: line.text,
        POS_TERMINAL_ID: tx.terminal ?? '',
        GV_TYP: line.gvTyp,
        GV_NAME: line.gvName ?? '',
        INHAUS: '',
        P_STORNO: '0',
        AGENTUR_ID: '0',
        ART_NR: line.artNr ?? '',
        GTIN: '',
        WARENGR_ID: line.warengrId ?? '',
        WARENGR: line.warengr ?? '',
        MENGE: formatQuantity(line.quantity),
        FAKTOR: formatQuantity(1),
        EINHEIT: 'Stück',
        STK_BR: formatPrice(line.unitCents),
      });
      const v = vatOf(line.grossCents, line.key);
      add('Bonpos_USt', {
        BON_ID: bonId,
        POS_ZEILE: posZeile,
        UST_SCHLUESSEL: formatInteger(line.key),
        POS_BRUTTO: formatAmount(line.grossCents),
        POS_NETTO: formatAmount(line.grossCents - v),
        POS_UST: formatAmount(v),
      });
      for (const p of line.price ?? []) {
        const pv = vatOf(p.grossCents, p.key);
        add('Bonpos_Preisfindung', {
          BON_ID: bonId,
          POS_ZEILE: posZeile,
          TYP: p.type,
          UST_SCHLUESSEL: formatInteger(p.key),
          PF_BRUTTO: formatAmount(p.grossCents),
          PF_NETTO: formatAmount(p.grossCents - pv),
          PF_UST: formatAmount(pv),
        });
      }
      for (const sub of line.sub ?? []) {
        const sv = vatOf(sub.grossCents, sub.key);
        add('Bonpos_Zusatzinfo', {
          BON_ID: bonId,
          POS_ZEILE: posZeile,
          ZI_ART_NR: sub.artNr ?? '',
          ZI_GTIN: '',
          ZI_NAME: sub.name,
          ZI_WARENGR_ID: '',
          ZI_WARENGR: '',
          ZI_MENGE: formatQuantity(sub.quantity),
          ZI_FAKTOR: formatQuantity(1),
          ZI_EINHEIT: 'Stück',
          ZI_UST_SCHLUESSEL: formatInteger(sub.key),
          ZI_BASISPREIS_BRUTTO: formatAmount(sub.grossCents),
          ZI_BASISPREIS_NETTO: formatAmount(sub.grossCents - sv),
          ZI_BASISPREIS_UST: formatAmount(sv),
        });
      }
      if (isBeleg) {
        const k = `${line.gvTyp}|${line.gvName ?? ''}|${line.key}`;
        const sum = gvSums.get(k) ?? {
          gvTyp: line.gvTyp,
          gvName: line.gvName ?? '',
          vatKey: line.key,
          gross: 0,
          net: 0,
          vat: 0,
        };
        sum.gross += line.grossCents;
        sum.net += line.grossCents - v;
        sum.vat += v;
        gvSums.set(k, sum);
      }
    });

    for (const ref of tx.references) {
      add('Bon_Referenzen', {
        BON_ID: bonId,
        POS_ZEILE: '',
        REF_TYP: 'Transaktion',
        REF_NAME: '',
        REF_DATUM: rfc3339Berlin(ref.closingCreatedAt),
        REF_Z_KASSE_ID: ref.registerId,
        REF_Z_NR: formatInteger(ref.zNr),
        REF_BON_ID: formatInteger(ref.bonId),
      });
    }

    if (tx.tseUnitId) {
      // Signatur nach Belegausgabe (Abgleich): Daten der TSE vollstaendig,
      // dazu TSE_TA_FEHLER — der Bon war ein Ausfallbeleg (Steuerberater
      // 2026-11-10, Frage 16; kein Nachsignieren, keine Umdeutung).
      const late =
        tx.status === 'failed' && tx.recovered && !!tx.signatureValue;
      const signed = tx.status === 'signed' || tx.status === 'training' || late;
      const start = tx.startTime ?? tx.finishTime;
      const error = late
        ? cleanText(
            `${LATE_SIGNATURE_NOTE} (TSE nicht erreichbar: ${[tx.errorCode, tx.errorMessage].filter(Boolean).join(' – ')})`,
            200,
          )
        : tx.status === 'failed'
          ? cleanText(
              `TSE ausgefallen: ${[tx.errorCode, tx.errorMessage].filter(Boolean).join(' – ')}`,
              200,
            )
          : '';
      const processData =
        tx.processData.trim() === tx.processData ? tx.processData : '';
      add('TSE_Transaktionen', {
        BON_ID: bonId,
        TSE_ID: formatInteger(tseIndex.get(tx.tseUnitId) ?? 0),
        TSE_TANR:
          tx.transactionNumber !== null
            ? formatInteger(tx.transactionNumber)
            : '',
        TSE_TA_START: signed && start ? isoUtcMillis(start) : '',
        TSE_TA_ENDE: signed && tx.finishTime ? isoUtcMillis(tx.finishTime) : '',
        TSE_TA_VORGANGSART: signed ? tx.processType : '',
        TSE_TA_SIGZ:
          signed && tx.signatureCounter !== null
            ? formatInteger(tx.signatureCounter)
            : '',
        TSE_TA_SIG: signed ? (tx.signatureValue ?? '') : '',
        TSE_TA_FEHLER: error,
        TSE_VORGANGSDATEN:
          signed && [...processData].length <= 1000 ? processData : '',
      });
    }
  }

  // --------------------------------------------------- Kassenabschluss
  const gvRows = [...gvSums.values()].sort(
    (a, b) =>
      (GV_ORDER.get(a.gvTyp) ?? 99) - (GV_ORDER.get(b.gvTyp) ?? 99) ||
      a.gvName.localeCompare(b.gvName) ||
      a.vatKey - b.vatKey,
  );
  for (const g of gvRows) {
    add('Z_GV_Typ', {
      GV_TYP: g.gvTyp,
      GV_NAME: g.gvName,
      AGENTUR_ID: '0',
      UST_SCHLUESSEL: formatInteger(g.vatKey),
      Z_UMS_BRUTTO: formatAmount(g.gross),
      Z_UMS_NETTO: formatAmount(g.net),
      Z_UST: formatAmount(g.vat),
    });
  }
  const payRows = [...paySums.values()].sort(
    (a, b) =>
      (PAYMENT_ORDER.get(a.type) ?? 99) - (PAYMENT_ORDER.get(b.type) ?? 99) ||
      a.name.localeCompare(b.name),
  );
  for (const p of payRows) {
    add('Z_Zahlart', {
      ZAHLART_TYP: p.type,
      ZAHLART_NAME: p.name,
      Z_ZAHLART_BETRAG: formatAmount(p.cents),
    });
  }
  const paymentsTotal = payRows.reduce((sum, p) => sum + p.cents, 0);
  const cashTotal = payRows
    .filter((p) => p.type === 'Bar')
    .reduce((sum, p) => sum + p.cents, 0);
  add('Z_Waehrungen', {
    ZAHLART_WAEH: master.register.baseCurrency,
    ZAHLART_BETRAG_WAEH: formatAmount(cashTotal),
  });

  // ---------------------------------------------------------- Stammdaten
  const firstBonId = transactions.length ? transactions[0].bonId : null;
  const lastBonId = transactions.length
    ? transactions[transactions.length - 1].bonId
    : null;
  const c = master.company;
  rows.Stamm_Abschluss.unshift(
    makeRow('Stamm_Abschluss', {
      ...key,
      Z_BUCHUNGSTAG: input.businessDate,
      TAXONOMIE_VERSION: DSFINVK_VERSION,
      Z_START_ID: firstBonId !== null ? formatInteger(firstBonId) : '',
      Z_ENDE_ID: lastBonId !== null ? formatInteger(lastBonId) : '',
      NAME: c.name,
      STRASSE: c.street,
      PLZ: c.zip,
      ORT: c.city,
      LAND: c.country,
      STNR: c.taxNumber,
      USTID: c.vatId,
      Z_SE_ZAHLUNGEN: formatAmount(paymentsTotal),
      Z_SE_BARZAHLUNGEN: formatAmount(cashTotal),
    }),
  );
  const l = master.location;
  add('Stamm_Orte', {
    LOC_NAME: l.name,
    LOC_STRASSE: l.street,
    LOC_PLZ: l.zip,
    LOC_ORT: l.city,
    LOC_LAND: l.country,
    LOC_USTID: l.vatId,
  });
  const r = master.register;
  add('Stamm_Kassen', {
    KASSE_BRAND: r.brand,
    KASSE_MODELL: r.model,
    KASSE_SERIENNR: r.id,
    KASSE_SW_BRAND: r.softwareBrand,
    KASSE_SW_VERSION: r.softwareVersion,
    KASSE_BASISWAEH_CODE: r.baseCurrency,
    KEINE_UST_ZUORDNUNG: '0',
  });
  for (const t of [...master.terminals].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    add('Stamm_Terminals', {
      TERMINAL_ID: t.id,
      TERMINAL_BRAND: t.brand,
      TERMINAL_MODELL: t.model,
      TERMINAL_SERIENNR: t.serial,
      TERMINAL_SW_BRAND: t.softwareBrand,
      TERMINAL_SW_VERSION: t.softwareVersion,
    });
  }
  for (const v of master.vatKeys) {
    add('Stamm_USt', {
      UST_SCHLUESSEL: formatInteger(v.key),
      UST_SATZ: formatRate(v.rate),
      UST_BESCHR: v.description,
    });
  }
  master.tseUnits.forEach((u, index) => {
    const cert = u.certificate ?? '';
    add('Stamm_TSE', {
      TSE_ID: formatInteger(index + 1),
      TSE_SERIAL: u.serial,
      TSE_SIG_ALGO: u.signatureAlgorithm,
      TSE_ZEITFORMAT: u.logTimeFormat,
      TSE_PD_ENCODING: 'UTF-8',
      TSE_PUBLIC_KEY: u.publicKey,
      TSE_ZERTIFIKAT_I: cert.slice(0, 1000),
      TSE_ZERTIFIKAT_II: cert.slice(1000, 2000),
    });
  });

  const totals: ClosingTotals = {
    grossCents: gross,
    salesGrossCents: gvRows
      .filter((g) => ['Umsatz', 'Rabatt', 'Aufschlag'].includes(g.gvTyp))
      .reduce((sum, g) => sum + g.gross, 0),
    paymentsCents: paymentsTotal,
    cashCents: cashTotal,
    byBusinessCase: gvRows.map((g) => ({
      gvTyp: g.gvTyp,
      gvName: g.gvName,
      vatKey: g.vatKey,
      grossCents: g.gross,
      netCents: g.net,
      vatCents: g.vat,
    })),
    byPaymentType: payRows.map((p) => ({
      type: p.type,
      name: p.name,
      cents: p.cents,
    })),
    byVatKey: [...vatSums.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([vatKey, s]) => ({
        vatKey,
        grossCents: s.gross,
        netCents: s.net,
        vatCents: s.vat,
      })),
    counts,
    firstBonId,
    lastBonId,
  };
  return { rows, totals };
}
