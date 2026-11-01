import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OrderFulfillmentType } from '../../database/entities/order.entity';
import { OrderItemStatus } from '../../database/entities/order-item.entity';
import { PaymentMethod } from '../../database/entities/payment.entity';
import { ErrorCodes, ErrorReasons } from '../constants/error-codes';

/**
 * Betriebsmodus der Organisation (`settings.operatingMode`).
 *
 * - `pos` (Standard): Kasse mit Bestellannahme, Zahlung, Erstattung,
 *   Kassenlade und Pfand-Auszahlung.
 * - `order_only` („Nur Bestellen“): OpenEOS nimmt Bestellungen auf und
 *   steuert Kueche, Stationen und Ausgabe, kennt aber kein Kassenmodul.
 *   Kassiert wird ausserhalb (offene Ladenkasse).
 *
 * Hintergrund (BMF-Antwort 2026-10): Ein Bestellsystem ohne Kassenmodul
 * faellt nicht unter § 146a AO — aber nur, wenn der Verein das Modul nicht
 * selbst einschalten kann. Deshalb schaltet ausschliesslich der Support
 * (Super-Admin) um, jede Umschaltung steht mit Grund im Protokoll
 * (`organization_operating_mode_changes` und Admin-Protokoll), und die
 * Organisation kann eine Herstellerbescheinigung als PDF abrufen.
 *
 * Durchgesetzt wird der Modus im Server: jeder Einstieg, der eine Zahlung
 * bucht oder abrechnet, ruft `assertPaymentsAllowed` auf und antwortet im
 * Modus `order_only` mit 403 `ORDER_ONLY_MODE`.
 *
 * Ausgenommen ist die Vorauszahlung der Gaeste online (Online-Shop und
 * QR-Bestellung ueber PayPal/SumUp Online): Sie laeuft nicht ueber die
 * Kasse vor Ort und ist nie Bargeld. Erstattet werden kann im Modus
 * `order_only` nur auf solche Online-Zahlungen.
 */
export const OPERATING_MODES = ['pos', 'order_only'] as const;
export type OperatingMode = (typeof OPERATING_MODES)[number];

export function isOperatingMode(value: unknown): value is OperatingMode {
  return (
    typeof value === 'string' &&
    (OPERATING_MODES as readonly string[]).includes(value)
  );
}

/** Nur ein ausdrueckliches `order_only` zaehlt; alles andere ist `pos`. */
export function getOperatingMode(
  settings: object | null | undefined,
): OperatingMode {
  const mode = (settings as { operatingMode?: unknown } | null)?.operatingMode;
  return mode === 'order_only' ? 'order_only' : 'pos';
}

export function isOrderOnlyMode(settings: object | null | undefined): boolean {
  return getOperatingMode(settings) === 'order_only';
}

/** Zeitpunkt der letzten Umschaltung (ISO) oder null. */
export function getOperatingModeSince(
  settings: object | null | undefined,
): string | null {
  const since = (settings as { operatingModeSince?: unknown } | null)
    ?.operatingModeSince;
  return typeof since === 'string' && since ? since : null;
}

/**
 * Entfernt Betriebsmodus und Zeitstempel aus eingehenden Einstellungen
 * (Organisation anlegen/bearbeiten, Admin-Bearbeitung). Umschalten geht
 * nur ueber den protokollierten Support-Endpunkt.
 */
export function stripOperatingMode<T extends object | null | undefined>(
  settings: T,
): T {
  if (settings && typeof settings === 'object') {
    delete (settings as Record<string, unknown>).operatingMode;
    delete (settings as Record<string, unknown>).operatingModeSince;
  }
  return settings;
}

export function orderOnlyModeError(): ForbiddenException {
  return new ForbiddenException({
    code: ErrorCodes.ORDER_ONLY_MODE,
    message:
      'Deine Organisation nutzt OpenEOS im Modus „Nur Bestellen“. Zahlungen, Erstattungen, Trinkgeld, Kassenlade und Pfand-Auszahlung gibt es darin nicht – kassiert wird außerhalb von OpenEOS.',
  });
}

/** Weist jeden Zahlungsvorgang im Modus `order_only` mit 403 ab. */
export function assertPaymentsAllowed(
  settings: object | null | undefined,
): void {
  if (isOrderOnlyMode(settings)) throw orderOnlyModeError();
}

/**
 * Online-Vorauszahlung des Gastes (Shop, QR-Bestellung). Nur darauf darf
 * im Modus `order_only` erstattet werden — zurueck an den Online-Anbieter,
 * nie aus einer Kasse.
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
 * Zubereitung). Solange es die gibt, laesst sich eine Bestellung im Modus
 * `order_only` nicht abschliessen — die Kueche wuerde sie sonst verlieren.
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
 * Abschluss ohne Zahlung im Modus `order_only`.
 *
 * - Theke/Abholung/Mitnahme: abgeschlossen, sobald alles ausgegeben ist —
 *   ohne Station also gleich beim Anlegen, mit Station, wenn die letzte
 *   Stationsposition ausgegeben (`delivered`) ist. Das entspricht dem
 *   Zeitpunkt, an dem im Kassenbetrieb bezahlt und abgeschlossen wird.
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
 * Abschluss im Modus `order_only`: was jetzt noch nicht ausgegeben ist,
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
