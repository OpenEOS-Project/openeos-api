import type { Composition } from '../refunds/refund-calc';

/**
 * Prozessdaten fuer die TSE nach DSFinV-K (Anhang I „Kassenbeleg-V1“,
 * „Bestellung-V1“) und der QR-Code nach DSFinV-K Anhang I (Version V0).
 * Reine Funktionen, alles in Cent gerechnet.
 *
 * Kassenbeleg-V1:
 *   `<Vorgangstyp>^<Brutto je Satz>^<Zahlungen>`
 *   - Vorgangstyp: `Beleg` (Verkauf, Erstattung), `AVTraining`
 *     (Testmodus), `AVBelegabbruch` (haengende Transaktion schliessen)
 *   - Brutto je Satz, fuenf Werte mit `_`, immer zwei Nachkommastellen,
 *     Punkt als Trenner, negativ mit `-`:
 *       1 allgemeiner Satz (19 %), 2 ermaessigter Satz (7 %),
 *       3 Durchschnittssatz § 24 Abs. 1 Nr. 3 UStG (10,7 %),
 *       4 Durchschnittssatz § 24 Abs. 1 Nr. 1 UStG (5,5 %),
 *       5 0 % (nicht steuerbar / steuerfrei)
 *   - Zahlungen: `<Betrag>:<Bar|Unbar>[:<Waehrung>]` mit `_`, Bar vor
 *     Unbar, Waehrung nur wenn nicht EUR.
 *   Beispiel: `Beleg^75.33_7.99_0.00_0.00_0.00^10.00:Bar_73.32:Unbar`
 *   Pfand zaehlt zum Satz seiner Pfandart (Becher 2 € zu 19 % → Slot 1),
 *   eine Pfand-Auszahlung steht negativ im selben Slot. Trinkgeld an den
 *   Verein steht anteilig in den Slots der Ware (Bier 10 € + 1 € Trinkgeld:
 *   `Beleg^11.00_0.00_0.00_0.00_0.00^11.00:Bar`), Trinkgeld einer
 *   angestellten Bedienung (TrinkgeldAN) im 0-%-Slot.
 *
 * Bestellung-V1: je Position `<Menge>;"<Bezeichnung>";<Stueckpreis brutto>`,
 * Zeilen mit CR (`\r`) getrennt; Storno mit negativer Menge.
 */

export const PROCESS_TYPE_RECEIPT = 'Kassenbeleg-V1';
export const PROCESS_TYPE_ORDER = 'Bestellung-V1';
/** Andere abzusichernde Vorgaenge (DSFinV-K Anhang I), z. B. Kellnerabrechnung. */
export const PROCESS_TYPE_OTHER = 'SonstigerVorgang';

export type ReceiptBusinessType = 'Beleg' | 'AVTraining' | 'AVBelegabbruch';
export type TsePaymentType = 'Bar' | 'Unbar';

/** Fuenf Steuer-Slots in Cent (Reihenfolge wie oben). */
export type VatSlots = [number, number, number, number, number];

export interface ReceiptPayment {
  type: TsePaymentType;
  cents: number;
  currency?: string;
}

export interface ReceiptAmounts {
  slots: VatSlots;
  payments: ReceiptPayment[];
}

export function emptySlots(): VatSlots {
  return [0, 0, 0, 0, 0];
}

/**
 * Slot (0..4) fuer einen Steuersatz. Steuerbefreite Organisationen
 * (Kleinunternehmer, `settings.vatExempt !== false`) buchen alles in den
 * 0-%-Slot. Unbekannte Saetze landen ebenfalls dort (es gibt in
 * Deutschland nur 19/7/0; Durchschnittssaetze nutzt OpenEOS nicht).
 */
export function vatSlot(rate: number, vatExempt: boolean): number {
  if (vatExempt) return 4;
  const r = Math.round(Number(rate) * 100) / 100;
  if (r === 19) return 0;
  if (r === 7) return 1;
  if (r === 10.7) return 2;
  if (r === 5.5) return 3;
  return 4;
}

/**
 * Slots aus einer Zusammensetzung (refund-calc). Pfand steht im Slot des
 * Satzes seiner Pfandart (Teil des Entgelts, Abschn. 10.1 Abs. 8 UStAE;
 * Bestand von vor 2026-11 ohne Satz: 0-%-Slot wie damals).
 *
 * Trinkgeld (Steuerberater 2026-11-10, Fragen 3–5): an den
 * umsatzsteuerpflichtigen Verein (`TrinkgeldAG`) ist es Entgelt und steht
 * mit `tipShares` (Anteile je Satz, siehe `tipByRate`) in den Slots der
 * Hauptleistung. Ohne `tipShares` — Trinkgeld an eine angestellte Bedienung
 * (`TrinkgeldAN`, kein Entgelt) oder steuerbefreite Organisation — im
 * 0-%-Slot.
 */
export function slotsFromComposition(
  composition: Composition,
  vatExempt: boolean,
  sign: 1 | -1 = 1,
  tipShares: Map<number, number> | null = null,
): VatSlots {
  const slots = emptySlots();
  for (const [rate, cents] of composition.goods) {
    slots[vatSlot(rate, vatExempt)] += sign * cents;
  }
  for (const [rate, cents] of composition.pfand) {
    slots[vatSlot(rate, vatExempt)] += sign * cents;
  }
  if (tipShares && tipShares.size > 0 && !vatExempt) {
    for (const [rate, cents] of tipShares) {
      slots[vatSlot(rate, false)] += sign * Math.abs(cents);
    }
  } else {
    slots[4] += sign * composition.tip;
  }
  return slots;
}

/**
 * Slots einer Pfand-Auszahlung: je Position Betrag (negativ) im Slot ihres
 * Satzes. Ohne Satz (Bestand) 0-%-Slot.
 * Beispiel 3 Becher à 2 € zu 19 %: `Beleg^-6.00_0.00_0.00_0.00_0.00^-6.00:Bar`.
 */
export function depositReturnSlots(
  lines: {
    unitAmount: number;
    quantity: number;
    vatRate?: number | null;
    legacyCents?: number | null;
  }[],
  vatExempt: boolean,
): VatSlots {
  const slots = emptySlots();
  for (const line of lines) {
    const amount = Math.abs(
      Math.round(Number(line.unitAmount) * 100) * Number(line.quantity),
    );
    // Pfand-Altsaldo (vor der Umstellung ohne USt verkauft): 0-%-Slot,
    // keine Steuerminderung (Steuerberater 2026-11-10, Frage 2).
    const legacy = Math.min(
      Math.max(0, Math.round(Number(line.legacyCents) || 0)),
      amount,
    );
    slots[4] -= legacy;
    slots[vatSlot(Number(line.vatRate ?? 0) || 0, vatExempt)] -=
      amount - legacy;
  }
  return slots;
}

export function slotsTotal(slots: VatSlots): number {
  return slots.reduce((sum, v) => sum + v, 0);
}

/** `-5.00`, `0.00`, `1234.56` (Cent rein, ohne Tausendertrenner). */
export function formatCents(cents: number): string {
  const value = Math.round(cents);
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function paymentTypeFor(
  method: string | null | undefined,
): TsePaymentType {
  return method === 'cash' ? 'Bar' : 'Unbar';
}

/** Fasst Zahlungen je Art/Waehrung zusammen, Bar vor Unbar, ohne Nullen. */
export function normalizePayments(
  payments: ReceiptPayment[],
): ReceiptPayment[] {
  const byKey = new Map<string, ReceiptPayment>();
  for (const p of payments) {
    const currency = (p.currency || 'EUR').toUpperCase();
    const key = `${p.type}:${currency}`;
    const existing = byKey.get(key);
    if (existing) existing.cents += Math.round(p.cents);
    else byKey.set(key, { type: p.type, cents: Math.round(p.cents), currency });
  }
  const order = (p: ReceiptPayment) =>
    (p.type === 'Bar' ? 0 : 2) + (p.currency === 'EUR' ? 0 : 1);
  return [...byKey.values()]
    .filter((p) => p.cents !== 0)
    .sort((a, b) => order(a) - order(b));
}

export function kassenbelegProcessData(
  type: ReceiptBusinessType,
  amounts: ReceiptAmounts,
): string {
  const slots = amounts.slots.map(formatCents).join('_');
  if (type === 'AVBelegabbruch') return `${type}^${slots}^`;
  let payments = normalizePayments(amounts.payments);
  // Ein Beleg ueber 0,00 (voll rabattiert) weist 0.00 bar aus.
  if (payments.length === 0)
    payments = [{ type: 'Bar', cents: 0, currency: 'EUR' }];
  const paymentText = payments
    .map(
      (p) =>
        `${formatCents(p.cents)}:${p.type}${p.currency && p.currency !== 'EUR' ? `:${p.currency}` : ''}`,
    )
    .join('_');
  return `${type}^${slots}^${paymentText}`;
}

/**
 * Kassenbuch-Buchung (Kassenbeleg-V1): Bargeldbewegung ohne Umsatzsteuer
 * im 0-%-Slot, Zahlung bar. Beispiele aus DSFinV-K Anhang I: Anfangsbestand
 * 100 € → `Beleg^0.00_0.00_0.00_0.00_100.00^100.00:Bar`, Einzahlung zur
 * Bank (Geldtransit) → `Beleg^0.00_0.00_0.00_0.00_-100.00^-100.00:Bar`.
 */
export function cashbookProcessData(amountCents: number): string {
  const slots = emptySlots();
  slots[4] = amountCents;
  return kassenbelegProcessData('Beleg', {
    slots,
    payments: [{ type: 'Bar', cents: amountCents }],
  });
}

/** Leerer Beleg fuer das Schliessen haengender Transaktionen. */
export function abortProcessData(): string {
  return kassenbelegProcessData('AVBelegabbruch', {
    slots: emptySlots(),
    payments: [],
  });
}

export interface OrderLine {
  quantity: number;
  name: string;
  /** Stueckpreis brutto in Cent (inkl. Optionen). */
  unitCents: number;
}

function formatQuantity(quantity: number): string {
  if (Number.isInteger(quantity)) return String(quantity);
  return String(Math.round(quantity * 1000) / 1000);
}

function quoteName(name: string): string {
  // Zeilen- und Feldtrenner aus dem Namen nehmen, Anfuehrungszeichen doppeln.
  const clean = name.replace(/[\r\n]+/g, ' ').trim();
  return `"${clean.replace(/"/g, '""')}"`;
}

export function bestellungProcessData(lines: OrderLine[]): string {
  return lines
    .filter((line) => line.quantity !== 0)
    .map(
      (line) =>
        `${formatQuantity(line.quantity)};${quoteName(line.name)};${formatCents(line.unitCents)}`,
    )
    .join('\r');
}

/** Unix-Sekunden → `2026-11-03T18:41:04.000Z` (UTC, wie die TSE liefert). */
export function isoFromUnix(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

export interface QrCodeInput {
  clientId: string;
  processType: string;
  processData: string;
  transactionNumber: number | string;
  signatureCounter: number | string;
  startTime: string;
  finishTime: string;
  signatureAlgorithm: string;
  logTimeFormat: string;
  signatureValue: string;
  publicKey: string;
}

/**
 * QR-Code-Inhalt nach DSFinV-K Anhang I (Version `V0`):
 * `V0;<Kassen-Seriennr.>;<processType>;<processData>;<TA-Nr.>;<Sig.-Zaehler>;
 *  <Start>;<Ende>;<Sig.-Algorithmus>;<Log-Zeitformat>;<Signatur>;<Public Key>`
 * Zeiten ISO 8601 in UTC, Signatur und Public Key Base64.
 */
export function qrCodePayload(input: QrCodeInput): string {
  return [
    'V0',
    input.clientId,
    input.processType,
    input.processData,
    String(input.transactionNumber),
    String(input.signatureCounter),
    input.startTime,
    input.finishTime,
    input.signatureAlgorithm,
    input.logTimeFormat,
    input.signatureValue,
    input.publicKey,
  ].join(';');
}

/**
 * Client-ID (= Seriennummer der Kasse) einer Organisation: `OEOS-` und die
 * ersten 12 Hex-Zeichen der Organisations-ID. TR-03153 erlaubt hoechstens
 * 30 Zeichen (Swissbit); Zeichen nur aus [A-Za-z0-9-].
 */
export function clientIdForOrganization(organizationId: string): string {
  const hex = organizationId.replace(/[^0-9a-fA-F]/g, '').slice(0, 12);
  return `OEOS-${hex.toUpperCase()}`;
}

/**
 * Kellnerabrechnung als `SonstigerVorgang` (Steuerberater 2026-11-10,
 * Frage 7: „Kellnerabrechnung als TSE-gesicherter Vorgang mit Soll,
 * gezaehltem Ist und Differenz“). Ohne Kellnerbrieftasche bewegt sie kein
 * Geld (das Bargeld liegt in der Schublade; die Differenz der Schublade
 * bucht der Kassensturz als DifferenzSollIst) — abgesichert werden die
 * Zahlen: `Kellnerabrechnung^<Nr>^Soll:<x>^Ist:<y>^Differenz:<z>`
 * (fehlendes Ist/Differenz leer).
 */
export function settlementProcessData(input: {
  number: number | null;
  expectedCents: number | null;
  countedCents: number | null;
  differenceCents: number | null;
}): string {
  const v = (cents: number | null) =>
    cents === null ? '' : formatCents(cents);
  return [
    'Kellnerabrechnung',
    input.number === null ? '' : String(input.number),
    `Soll:${v(input.expectedCents)}`,
    `Ist:${v(input.countedCents)}`,
    `Differenz:${v(input.differenceCents)}`,
  ].join('^');
}

/**
 * Auszahlung von Kartentrinkgeld an eine angestellte Bedienung
 * (Steuerberater 2026-11-10, Frage 5): TrinkgeldAN negativ, Bar negativ,
 * z. B. `Beleg^0.00_0.00_0.00_0.00_-5.20^-5.20:Bar`.
 */
export function tipPayoutProcessData(amountCents: number): string {
  const amount = -Math.abs(Math.round(amountCents));
  const slots = emptySlots();
  slots[4] = amount;
  return kassenbelegProcessData('Beleg', {
    slots,
    payments: [{ type: 'Bar', cents: amount }],
  });
}

/** Wertmarken-Anteil fuer die Prozessdaten (Euro, mit Art und Satz). */
export interface TokenSlotLine {
  kind: 'multi_purpose' | 'single_purpose';
  /** Betrag in Euro (Vorzeichen wie gebucht). */
  amount: number;
  vatRate?: number | null;
}

/**
 * Slot einer Wertmarke: Mehrzweckgutschein (und alles bei steuerbefreiten
 * Organisationen) im 0-%-Slot (nicht steuerbar), Einzweckgutschein im Slot
 * seines Satzes (Steuerberater 2026-11-10, Frage 13; DSFinV-K Anhang C).
 */
export function tokenSlot(line: TokenSlotLine, vatExempt: boolean): number {
  if (vatExempt || line.kind !== 'single_purpose') return 4;
  return vatSlot(Number(line.vatRate ?? 0) || 0, false);
}

/**
 * Verkauf (positiv) bzw. Ruecktausch (negativ) von Wertmarken.
 * Mehrzweck 100 € bar: `Beleg^0.00_0.00_0.00_0.00_100.00^100.00:Bar`;
 * Einzweck „Getraenkemarke“ (19 %) 30 €: `Beleg^30.00_0.00_0.00_0.00_0.00^30.00:Bar`.
 */
export function tokenSaleSlots(
  lines: TokenSlotLine[],
  vatExempt: boolean,
): VatSlots {
  const slots = emptySlots();
  for (const line of lines) {
    slots[tokenSlot(line, vatExempt)] += Math.round(Number(line.amount) * 100);
  }
  return slots;
}

/**
 * Einloesung im Kassenbeleg einer Zahlung: der mit Marken beglichene Teil
 * steht negativ im Slot der Marke (Mehrzweck 0 %, Einzweck Satz), die Ware
 * bleibt mit ihrem Satz stehen. `sign` -1 fuer die Rueckgabe von Marken bei
 * einer Erstattung (Einloesung wird zurueckgenommen).
 * Beispiel aus dem Steuerberater-Gutachten: Ware 60 € zu 19 % + 60 € zu 7 %,
 * 100 € in Mehrzweckmarken, 20 € bar →
 * `Beleg^60.00_60.00_0.00_0.00_-100.00^20.00:Bar`.
 */
export function applyTokenRedemption(
  slots: VatSlots,
  lines: TokenSlotLine[],
  vatExempt: boolean,
  sign: 1 | -1 = 1,
): VatSlots {
  const out = [...slots] as VatSlots;
  for (const line of lines) {
    out[tokenSlot(line, vatExempt)] -=
      sign * Math.abs(Math.round(Number(line.amount) * 100));
  }
  return out;
}
