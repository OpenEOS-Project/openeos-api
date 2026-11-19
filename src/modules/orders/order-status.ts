import { OrderStatus } from '../../database/entities/order.entity';
import {
  OrderItem,
  OrderItemStatus,
} from '../../database/entities/order-item.entity';

type StatusItem = Pick<OrderItem, 'status' | 'productionStationId'>;

const isDone = (i: StatusItem) =>
  i.status === OrderItemStatus.READY || i.status === OrderItemStatus.DELIVERED;

/**
 * Bestellstatus aus den Positionen (Kueche, Ausgabe, Storno/Erstattung):
 *
 * - keine aktiven Positionen → `open`,
 * - `ready`, sobald jede Position mit Station fertig oder ausgegeben ist.
 *   Positionen ohne Station (z. B. Getraenke, die die Theke gleich
 *   mitgibt) halten die Bestellung nicht auf — keine Station meldet sie je
 *   fertig. Das ist dieselbe Sicht wie an der Kasse („Bereit zur Ausgabe“,
 *   `itemsInProduction`) und beim Abschluss (`workflowDone`).
 *   Die Station steht an der Position (beim Anlegen aus Produkt, sonst
 *   Kategorie uebernommen).
 * - Ganz ohne Stationsposition gilt die alte Regel: `ready` nur, wenn alle
 *   Positionen fertig oder ausgegeben sind. Solche Bestellungen schliessen
 *   Zahlung, „Abgeholt“ bzw. „Nur Bons“ beim Anlegen ab.
 * - sonst `in_progress`, sobald eine Position nicht mehr `pending` ist.
 */
export function orderStatusFromItems(
  items: StatusItem[],
  current: OrderStatus,
): OrderStatus {
  const activeItems = items.filter(
    (i) => i.status !== OrderItemStatus.CANCELLED,
  );
  if (activeItems.length === 0) return OrderStatus.OPEN;
  const routed = activeItems.filter((i) => !!i.productionStationId);
  const relevant = routed.length > 0 ? routed : activeItems;
  if (relevant.every(isDone)) return OrderStatus.READY;
  if (activeItems.some((i) => i.status !== OrderItemStatus.PENDING)) {
    return OrderStatus.IN_PROGRESS;
  }
  return current;
}
