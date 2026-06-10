import { OrderFulfillmentType } from '../../database/entities/order.entity';
import { OrganizationSettings } from '../../database/entities/organization.entity';

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
