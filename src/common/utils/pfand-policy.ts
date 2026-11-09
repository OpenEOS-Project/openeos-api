import { OrderFulfillmentType } from '../../database/entities/order.entity';
import { OrganizationSettings } from '../../database/entities/organization.entity';
import { DEFAULT_PFAND_VAT_RATE } from '../../database/entities/pfand-type.entity';

/**
 * Decides whether a deposit (Pfand) is charged for an order, based on its
 * fulfillment type and the organization's Pfand policy.
 *
 * Defaults when unconfigured: table-service guests pay NO deposit, while
 * counter/takeaway orders DO — matching the common festival expectation.
 */
export function isPfandChargedForFulfillment(
  fulfillmentType: OrderFulfillmentType | null | undefined,
  settings: OrganizationSettings | null | undefined,
): boolean {
  const pfand = settings?.pfand;
  if (fulfillmentType === OrderFulfillmentType.TABLE_SERVICE) {
    return pfand?.tableService ?? false;
  }
  return pfand?.counterPickup ?? true;
}

/**
 * Umsatzsteuersatz einer Pfandart fuer den Snapshot auf der Position bzw.
 * der Auszahlung. Pfand gehoert zum Entgelt (Abschn. 10.1 Abs. 8 UStAE) und
 * traegt den Satz seiner Pfandart; fehlt er (alte Datensaetze ohne Spalte),
 * gilt der Standard 19 %. Ob die Organisation MwSt ausweist (Kleinunternehmer),
 * entscheidet erst die Auswertung (`vatExempt`) — der Satz wird trotzdem
 * festgehalten.
 */
export function pfandVatRate(
  pfandType: { vatRate?: number | string | null } | null | undefined,
): number {
  const rate = Number(pfandType?.vatRate);
  return pfandType?.vatRate === null ||
    pfandType?.vatRate === undefined ||
    !Number.isFinite(rate)
    ? DEFAULT_PFAND_VAT_RATE
    : rate;
}
