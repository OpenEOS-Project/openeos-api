/**
 * Kassiermodus einer Veranstaltung (Spezifikation §1, F8):
 *
 * - `immediate` („Sofort kassieren“): Eine Bestellung der Kasse entsteht
 *   erst zusammen mit ihrer Zahlung. Küche und Stationen sehen nie etwas
 *   Unbezahltes.
 * - `tab` („Offene Rechnungen“): „Senden“ legt unbezahlte Bestellungen an,
 *   kassiert wird später.
 *
 * Wirksam ist der Wert der Veranstaltung, sonst der der Organisation
 * (`settings.pos.orderingMode`), sonst `immediate` — überall gleich
 * (Kasse, Verwaltung, Geräte-API).
 */
export type OrderingMode = 'immediate' | 'tab';

export const DEFAULT_ORDERING_MODE: OrderingMode = 'immediate';

export function resolveOrderingMode(
  eventSettings?: { orderingMode?: string | null } | null,
  organizationSettings?: {
    pos?: { orderingMode?: string | null } | null;
  } | null,
): OrderingMode {
  const value =
    eventSettings?.orderingMode || organizationSettings?.pos?.orderingMode;
  return value === 'tab' ? 'tab' : DEFAULT_ORDERING_MODE;
}
