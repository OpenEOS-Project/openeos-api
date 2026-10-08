import type {
  OrderItem,
  OrderItemOptions,
  OrderItemStatus,
} from '../../database/entities/order-item.entity';
import type {
  OrderFulfillmentType,
  OrderPriority,
  OrderSource,
} from '../../database/entities/order.entity';

/**
 * Antwortform von `GET /device-api/station/items` (Stationsanzeige).
 * Nur die Felder, die die Station braucht — keine weiteren
 * personenbezogenen Daten (Telefon, E-Mail, ...).
 */
export interface StationOrderInfo {
  id: string;
  orderNumber: string;
  dailyNumber: number;
  tableNumber: string | null;
  customerName: string | null;
  priority: OrderPriority;
  createdAt: Date;
  fulfillmentType: OrderFulfillmentType;
  source: OrderSource;
  /** Bestellnotiz; die Kasse markiert To-go mit `notes: 'To-go'`. */
  notes: string | null;
}

export interface StationItem {
  id: string;
  productName: string;
  categoryName: string;
  quantity: number;
  status: OrderItemStatus;
  notes: string | null;
  kitchenNotes: string | null;
  options: OrderItemOptions;
  createdAt: Date;
}

export interface StationOrder {
  order: StationOrderInfo;
  items: StationItem[];
}

/** Gruppiert offene Positionen (mit geladener `order`) nach Bestellung, Reihenfolge bleibt. */
export function groupStationItems(items: OrderItem[]): StationOrder[] {
  const byOrder = new Map<string, StationOrder>();
  for (const item of items) {
    const order = item.order;
    let entry = byOrder.get(order.id);
    if (!entry) {
      entry = {
        order: {
          id: order.id,
          orderNumber: order.orderNumber,
          dailyNumber: order.dailyNumber,
          tableNumber: order.tableNumber,
          customerName: order.customerName,
          priority: order.priority,
          createdAt: order.createdAt,
          fulfillmentType: order.fulfillmentType,
          source: order.source,
          notes: order.notes ?? null,
        },
        items: [],
      };
      byOrder.set(order.id, entry);
    }
    entry.items.push({
      id: item.id,
      productName: item.productName,
      categoryName: item.categoryName,
      quantity: item.quantity,
      status: item.status,
      notes: item.notes,
      kitchenNotes: item.kitchenNotes,
      options: item.options,
      createdAt: item.createdAt,
    });
  }
  return Array.from(byOrder.values());
}
