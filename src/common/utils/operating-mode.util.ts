import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OrderFulfillmentType } from '../../database/entities/order.entity';
import { OrderItemStatus } from '../../database/entities/order-item.entity';
import { PaymentMethod } from '../../database/entities/payment.entity';
import { ErrorCodes, ErrorReasons } from '../constants/error-codes';
import { hasActiveTse } from './tse.util';

/**
 * Betriebsart der Organisation (betriebsarten-spec.md, Entscheidung vom
 * 2026-11-02). Eine Einstellung, drei Werte:
 *
 * | Wert          | UI                | Geld in OpenEOS                              |
 * |---------------|-------------------|----------------------------------------------|
 * | `orders_only` | „Nur Bons“        | keine Preise, keine Zahlungen                |
 * | `cashless`    | „Bargeldlos“      | Karte (SumUp) und Online, nie Bargeld        |
 * | `full`        | „Alle Funktionen“ | Bargeld, Karte, Online; DE nur mit Cloud-TSE |
 *
 * Gespeichert in `organizations.operating_mode`, dazu
 * `operating_mode_legacy`: Organisationen, die es vor der Einfuehrung gab,
 * verhalten sich als `full` ohne TSE (auch in Deutschland), bis sie selbst
 * eine Betriebsart waehlen. Jede Wahl hebt den Bestand auf; zurueck zu
 * `full` geht es in Deutschland dann nur mit aktiver TSE.
 *
 * In Deutschland ist Bargeld ohne TSE nie moeglich — deshalb darf der
 * Verein selbst zwischen den Betriebsarten wechseln (BMF: Bargeld darf ohne
 * TSE nicht vom Verein aktivierbar sein). Der Server prueft das bei jeder
 * Barzahlung (`assertCashAllowed`), nicht nur beim Umschalten: faellt die
 * TSE weg, ist Bargeld in `full` sofort gesperrt (403
 * TSE_REQUIRED_FOR_CASH).
 */
export const OPERATING_MODES = ['orders_only', 'cashless', 'full'] as const;
export type OperatingMode = (typeof OPERATING_MODES)[number];

/** Verlaufswert fuer „Alle Funktionen (Bestand)“. */
export const LEGACY_FULL = 'full_legacy';

export function isOperatingMode(value: unknown): value is OperatingMode {
  return (
    typeof value === 'string' &&
    (OPERATING_MODES as readonly string[]).includes(value)
  );
}

/** Was die Regeln von einer Organisation brauchen. */
export interface OperatingModeOrg {
  id?: string;
  country?: string | null;
  settings?: object | null;
  tseActive?: boolean | null;
  operatingMode?: string | null;
  operatingModeLegacy?: boolean | null;
  operatingModeSince?: Date | string | null;
}

/**
 * Spalten, die jede Abfrage fuer die Pruefungen hier laden muss. Fehlt eine
 * (z. B. `select: { id, settings }`), saehe eine deutsche Organisation wie
 * eine ohne Land und jede wie `full` aus. `settings` kommt mit, weil die
 * Zahlungswege daneben die Integrationen pruefen.
 */
export const OPERATING_MODE_SELECT = {
  id: true,
  settings: true,
  country: true,
  operatingMode: true,
  operatingModeLegacy: true,
  operatingModeSince: true,
  // hasActiveTse (tse.util.ts) liest sie; ohne sie saehe jede deutsche
  // Organisation mit TSE wie eine ohne aus (Bargeld gesperrt).
  tseActive: true,
} as const;

/** Unbekannt oder nicht geladen: `full` (wie jede Bestandsorganisation). */
export function getOperatingMode(
  org: OperatingModeOrg | null | undefined,
): OperatingMode {
  const mode = org?.operatingMode;
  return isOperatingMode(mode) ? mode : 'full';
}

export function isOrdersOnly(
  org: OperatingModeOrg | null | undefined,
): boolean {
  return getOperatingMode(org) === 'orders_only';
}

function countryOf(org: OperatingModeOrg | null | undefined): string {
  return (org?.country ?? '').toUpperCase();
}

/** Bargeld in OpenEOS moeglich? (abgeleitet, nie gespeichert) */
export function isCashAllowed(
  org: OperatingModeOrg | null | undefined,
): boolean {
  if (getOperatingMode(org) !== 'full') return false;
  if (countryOf(org) !== 'DE') return true;
  return org?.operatingModeLegacy === true || hasActiveTse(org);
}

/** Preise und Betraege an Kasse, Bons, Kundendisplay und Berichten? */
export function arePricesVisible(
  org: OperatingModeOrg | null | undefined,
): boolean {
  return !isOrdersOnly(org);
}

export type ModeUnavailableReason =
  | 'tse_required'
  | 'paid_event_required'
  | 'country_required';

/**
 * Was die Cloud-TSE fuer die Wahl von `full` in Deutschland beitraegt:
 * - `available`: der Server bietet die Cloud-TSE an,
 * - `follows`: dazu steht eine bezahlte Veranstaltung an — die TSE wird
 *   dann automatisch eingerichtet (TseAutoActivationService), `full` ist
 *   schon vorher waehlbar (Bargeld erst mit aktiver TSE).
 */
export interface TseModeContext {
  available?: boolean;
  follows?: boolean;
}

/**
 * Darf die Organisation in diese Betriebsart wechseln? `null` = ja. Ohne
 * Land keine Wahl (die Regeln haengen am Land); `full` in Deutschland nur
 * mit aktiver TSE — oder wenn sie mit einer bezahlten Veranstaltung
 * automatisch folgt (`paid_event_required`, solange keine ansteht).
 */
export function modeUnavailableReason(
  org: OperatingModeOrg | null | undefined,
  mode: OperatingMode,
  tse: TseModeContext = {},
): ModeUnavailableReason | null {
  if (!countryOf(org)) return 'country_required';
  if (mode === 'full' && countryOf(org) === 'DE' && !hasActiveTse(org)) {
    if (tse.follows) return null;
    return tse.available ? 'paid_event_required' : 'tse_required';
  }
  return null;
}

/** Felder fuer Antworten an Oberflaeche und Kasse. */
export interface OperatingModeView {
  country: string | null;
  operatingMode: OperatingMode;
  operatingModeLegacy: boolean;
  operatingModeSince: string | null;
  tseActive: boolean;
  cashAllowed: boolean;
  pricesVisible: boolean;
}

export function operatingModeView(
  org: OperatingModeOrg | null | undefined,
): OperatingModeView {
  const since = org?.operatingModeSince;
  return {
    country: org?.country ?? null,
    operatingMode: getOperatingMode(org),
    operatingModeLegacy: org?.operatingModeLegacy === true,
    operatingModeSince:
      since instanceof Date
        ? since.toISOString()
        : typeof since === 'string' && since
          ? since
          : null,
    tseActive: hasActiveTse(org),
    cashAllowed: isCashAllowed(org),
    pricesVisible: arePricesVisible(org),
  };
}

/**
 * Betriebsart einer neuen Organisation: in Deutschland `cashless` (ohne TSE
 * ist `full` dort nicht waehlbar), sonst `full`. Eigene Installation
 * (Selbstbetrieb): `full` mit Bestand — der Verein betreibt den Server
 * selbst, eine Sperre durch den Hersteller gibt es dort nicht.
 */
export function initialOperatingMode(
  country: string | null | undefined,
  selfHosted: boolean,
): {
  operatingMode: OperatingMode;
  operatingModeLegacy: boolean;
  operatingModeSince: Date;
} {
  const operatingModeSince = new Date();
  if (selfHosted) {
    return {
      operatingMode: 'full',
      operatingModeLegacy: true,
      operatingModeSince,
    };
  }
  const de = (country ?? '').toUpperCase() === 'DE';
  return {
    operatingMode: de ? 'cashless' : 'full',
    operatingModeLegacy: false,
    operatingModeSince,
  };
}

/** Herstellerbescheinigung: Deutschland, Betriebsart ohne Bargeld. */
export function isCertificateAvailable(
  org: OperatingModeOrg | null | undefined,
): boolean {
  return countryOf(org) === 'DE' && getOperatingMode(org) !== 'full';
}

export function orderOnlyModeError(): ForbiddenException {
  return new ForbiddenException({
    code: ErrorCodes.ORDER_ONLY_MODE,
    message:
      'Deine Organisation nutzt OpenEOS in der Betriebsart „Nur Bons“. Preise, Zahlungen, Erstattungen, Trinkgeld, Rabatte, Pfand und Kassenlade gibt es darin nicht – kassiert wird außerhalb von OpenEOS.',
  });
}

export function cashDisabledError(): ForbiddenException {
  return new ForbiddenException({
    code: ErrorCodes.CASH_PAYMENTS_DISABLED,
    message:
      'Deine Organisation arbeitet in der Betriebsart „Bargeldlos“. Bargeld kann über OpenEOS nicht erfasst oder ausgezahlt werden.',
  });
}

export function tseRequiredError(reason?: string): ForbiddenException {
  return new ForbiddenException({
    code: ErrorCodes.TSE_REQUIRED_FOR_CASH,
    ...(reason ? { reason } : {}),
    message:
      'Bargeld geht in Deutschland nur mit einer aktiven Cloud-TSE. Deine Organisation hat keine aktive TSE – Karte und Online-Zahlung gehen weiter.',
  });
}

/**
 * Weist jeden Zahlungsvorgang (Zahlung, Erstattung, Trinkgeld, Rabatt,
 * Pfand-Auszahlung, Kassenlade, Shop- und QR-Bestellung) in der
 * Betriebsart `orders_only` mit 403 ORDER_ONLY_MODE ab.
 */
export function assertPaymentsAllowed(
  org: OperatingModeOrg | null | undefined,
): void {
  if (isOrdersOnly(org)) throw orderOnlyModeError();
}

/**
 * Weist Bargeld ab, wo es nicht erlaubt ist:
 * - `orders_only`: 403 ORDER_ONLY_MODE (gar keine Zahlung),
 * - `cashless`: 403 CASH_PAYMENTS_DISABLED,
 * - `full` in Deutschland ohne aktive TSE (ausser Bestand): 403
 *   TSE_REQUIRED_FOR_CASH.
 *
 * Mit Zahlart: nur `cash` wird abgewiesen, Karte, SumUp und Online laufen
 * weiter. Ohne Zahlart (`undefined`) ist der Vorgang selbst ein reiner
 * Bargeldvorgang (Pfand-Auszahlung, Kassenlade, Bar-Erstattung).
 */
export function assertCashAllowed(
  org: OperatingModeOrg | null | undefined,
  paymentMethod?: string | null,
): void {
  // `PaymentMethod.CASH` als Text: unbekannte Werte sind kein Bargeld.
  if (paymentMethod !== undefined && paymentMethod !== 'cash') return;
  const mode = getOperatingMode(org);
  if (mode === 'orders_only') throw orderOnlyModeError();
  if (mode === 'cashless') throw cashDisabledError();
  if (!isCashAllowed(org)) throw tseRequiredError();
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

/**
 * Entfernt Felder der frueheren Zwischenloesungen aus eingehenden
 * Einstellungen (Organisation anlegen/bearbeiten, Admin-Bearbeitung): die
 * Betriebsart steht in eigenen Spalten und wechselt nur ueber den
 * protokollierten Endpunkt.
 */
export function stripModeSettings<T extends object | null | undefined>(
  settings: T,
): T {
  if (settings && typeof settings === 'object') {
    const s = settings as Record<string, unknown>;
    delete s.operatingMode;
    delete s.operatingModeSince;
    const payments = s.payments;
    if (payments && typeof payments === 'object') {
      const p = payments as Record<string, unknown>;
      delete p.cashless;
      delete p.changedAt;
      if (Object.keys(p).length === 0) delete s.payments;
    }
  }
  return settings;
}

/**
 * Online-Vorauszahlung des Gastes (Shop, QR-Bestellung). Nur darauf darf
 * in der Betriebsart `orders_only` noch erstattet werden — fuer Zahlungen
 * aus der Zeit vor dem Wechsel, zurueck an den Online-Anbieter.
 */
export function isOnlinePrepaymentMethod(
  method: PaymentMethod | string | null | undefined,
): boolean {
  return (
    method === PaymentMethod.PAYPAL || method === PaymentMethod.SUMUP_ONLINE
  );
}

type ItemLike = {
  status: OrderItemStatus;
  productionStationId?: string | null;
};

function activeItems<T extends ItemLike>(items: T[]): T[] {
  return items.filter((i) => i.status !== OrderItemStatus.CANCELLED);
}

/**
 * Positionen, an denen eine Station noch arbeitet (offen oder in
 * Zubereitung). Solange es die gibt, laesst sich eine Bestellung in der Betriebsart
 * `orders_only` nicht abschliessen — die Kueche wuerde sie sonst verlieren.
 */
export function itemsStillInProduction<T extends ItemLike>(items: T[]): T[] {
  return activeItems(items).filter(
    (i) =>
      !!i.productionStationId &&
      (i.status === OrderItemStatus.PENDING ||
        i.status === OrderItemStatus.PREPARING),
  );
}

/**
 * Abschluss ohne Zahlung in der Betriebsart `orders_only`.
 *
 * - Theke/Abholung/Mitnahme: abgeschlossen, sobald alles ausgegeben ist —
 *   ohne Station also gleich beim Anlegen, mit Station, wenn die letzte
 *   Stationsposition ausgegeben (`delivered`) ist. Das entspricht dem
 *   Zeitpunkt, an dem im Betrieb mit Zahlung bezahlt und abgeschlossen wird.
 * - Tischbetrieb: nie automatisch. Der Tisch bleibt offen, bis die
 *   Bedienung „Abschließen“ tippt (statt „Kassieren“) — so sieht sie,
 *   welche Bestellungen an dem Tisch noch laufen.
 */
export function shouldAutoCompleteOrderOnly(
  fulfillmentType: OrderFulfillmentType | string | null | undefined,
  items: ItemLike[],
): boolean {
  if (fulfillmentType === OrderFulfillmentType.TABLE_SERVICE) return false;
  const active = activeItems(items);
  if (active.length === 0) return false;
  return active.every(
    (i) => !i.productionStationId || i.status === OrderItemStatus.DELIVERED,
  );
}

/**
 * Abschluss in der Betriebsart `orders_only`: was jetzt noch nicht ausgegeben ist,
 * gilt als ausgegeben (`delivered`) — Positionen ohne Station (z. B.
 * Getraenke, die gleich mitgegeben werden) und fertige Stationspositionen.
 * Sonst stuenden in einer abgeschlossenen Bestellung Positionen auf „offen“.
 *
 * Positionen, an denen eine Station noch arbeitet, bleiben unberuehrt; der
 * Aufrufer stellt sicher, dass es keine gibt (`assertOrderOnlyCompletable`
 * bzw. `shouldAutoCompleteOrderOnly`). Aendert die Positionen und gibt die
 * geaenderten zurueck, damit der Aufrufer sie speichert.
 */
export function handOverOnCompletion<
  T extends ItemLike & { deliveredAt?: Date | null },
>(items: T[], now: Date): T[] {
  const changed = activeItems(items).filter(
    (i) =>
      i.status !== OrderItemStatus.DELIVERED &&
      (!i.productionStationId || i.status === OrderItemStatus.READY),
  );
  for (const item of changed) {
    item.status = OrderItemStatus.DELIVERED;
    item.deliveredAt = now;
  }
  return changed;
}

/** 400, solange eine Station an der Bestellung noch arbeitet. */
export function assertOrderOnlyCompletable(
  items: (ItemLike & { productName?: string })[],
): void {
  const open = itemsStillInProduction(items);
  if (open.length === 0) return;
  throw new BadRequestException({
    code: ErrorCodes.VALIDATION_ERROR,
    reason: ErrorReasons.ORDER_ITEMS_IN_PRODUCTION,
    message:
      open.length === 1
        ? `${open[0].productName ?? 'Eine Position'} ist noch in Zubereitung. Schließe die Bestellung ab, wenn alles fertig ist.`
        : `${open.length} Positionen sind noch in Zubereitung. Schließe die Bestellung ab, wenn alles fertig ist.`,
    params: { products: open.map((i) => i.productName ?? '') },
  });
}
