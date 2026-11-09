import type {
  CashPointClosing,
  Event,
  Order,
  OrderItem,
  Payment,
  PfandReturn,
  Product,
  Refund,
} from '../../database/entities';
import {
  WEBHOOK_API_VERSION,
  type WebhookEventType,
} from './webhook-event-types';

/**
 * Was ein Webhook ueber Bestellungen, Zahlungen usw. verraet — bewusst
 * schmal (Datenminimierung):
 * - keine Bediener, Kassierer oder Geraete-Tokens, keine Freitexte des
 *   Personals (Storno-Begruendungen, Erstattungsgruende als Text);
 * - Gaesteangaben (Name, Telefon, Notizen der Bestellung und der
 *   Positionen) nur, wenn der Endpunkt „Gästedaten mitsenden“ eingeschaltet
 *   hat (`guest`);
 * - in der Betriebsart „Nur Bons“ (`orders_only`) keine Betraege
 *   (`amounts: null`, Positionen ohne Preise) — wie Berichte und MCP.
 * Geld als Zahl in EUR mit zwei Nachkommastellen, Zeiten ISO-8601.
 */

export interface PayloadOptions {
  /** Betraege weglassen (Betriebsart „Nur Bons“). */
  ordersOnly: boolean;
  /** Gaesteangaben mitsenden. */
  includeGuestData: boolean;
}

const money = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const iso = (value: Date | string | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null;

export function orderData(
  order: Order,
  items: OrderItem[],
  options: PayloadOptions,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    id: order.id,
    orderNumber: order.orderNumber,
    dailyNumber: order.dailyNumber,
    eventId: order.eventId,
    status: order.status,
    paymentStatus: order.paymentStatus,
    source: order.source,
    fulfillmentType: order.fulfillmentType ?? null,
    tableNumber: order.tableNumber ?? null,
    isTest: order.isTest,
    currency: 'EUR',
    createdAt: iso(order.createdAt),
    completedAt: iso(order.completedAt),
    cancelledAt: iso(order.cancelledAt),
    amounts: options.ordersOnly
      ? null
      : {
          subtotal: money(order.subtotal),
          taxTotal: money(order.taxTotal),
          total: money(order.total),
          paidAmount: money(order.paidAmount),
          tipAmount: money(order.tipAmount),
          discountAmount: money(order.discountAmount),
          refundedAmount: money(order.refundedAmount),
          pfandTotal: money(order.pfandTotal),
        },
    items: [...items]
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map((item) => orderItemData(item, options)),
  };
  if (options.includeGuestData) {
    data.guest = {
      name: order.customerName ?? null,
      phone: order.customerPhone ?? null,
      notes: order.notes ?? null,
    };
  }
  return data;
}

function orderItemData(
  item: OrderItem,
  options: PayloadOptions,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    id: item.id,
    productId: item.productId,
    productName: item.productName,
    categoryName: item.categoryName,
    quantity: item.quantity,
  };
  if (!options.ordersOnly) {
    data.unitPrice = money(item.unitPrice);
    data.optionsPrice = money(item.optionsPrice);
    data.totalPrice = money(item.totalPrice);
    data.taxRate = Number(item.taxRate);
  }
  data.options = (item.options?.selected ?? []).map((o) =>
    o.group ? `${o.group}: ${o.option}` : o.option,
  );
  data.status = item.status;
  if (options.includeGuestData) {
    data.notes = item.notes ?? null;
  }
  return data;
}

export function paymentData(
  payment: Payment,
  order: Pick<Order, 'orderNumber' | 'eventId' | 'isTest'>,
): Record<string, unknown> {
  return {
    id: payment.id,
    orderId: payment.orderId,
    orderNumber: order.orderNumber,
    eventId: order.eventId,
    method: payment.paymentMethod,
    provider: payment.paymentProvider,
    amount: money(payment.amount),
    status: payment.status,
    isTest: order.isTest,
    createdAt: iso(payment.createdAt),
  };
}

export function refundData(
  refund: Refund,
  order: Pick<Order, 'orderNumber'> | null,
): Record<string, unknown> {
  return {
    id: refund.id,
    refundNumber: refund.refundNumber,
    orderId: refund.orderId,
    orderNumber: order?.orderNumber ?? null,
    eventId: refund.eventId,
    kind: refund.kind,
    amount: money(refund.amount),
    taxTotal: money(refund.taxTotal),
    pfandAmount: money(refund.pfandAmount),
    tipAmount: money(refund.tipAmount),
    paymentMethod: refund.paymentMethod,
    status: refund.status,
    reasonCode: refund.reasonCode,
    isTest: refund.isTest || refund.status === 'test',
    createdAt: iso(refund.createdAt),
    items: (refund.items ?? []).map((item) => ({
      productName: item.productName,
      quantity: item.quantity,
      amount: money(item.amount),
    })),
  };
}

export function pfandReturnData(
  pfandReturn: PfandReturn,
  options: PayloadOptions,
): Record<string, unknown> {
  return {
    id: pfandReturn.id,
    returnNumber: pfandReturn.returnNumber,
    eventId: pfandReturn.eventId,
    totalAmount: options.ordersOnly ? null : money(pfandReturn.totalAmount),
    lines: (pfandReturn.lines ?? []).map((line) => ({
      pfandTypeId: line.pfandTypeId,
      name: line.name,
      unitAmount: options.ordersOnly ? null : money(line.unitAmount),
      quantity: line.quantity,
    })),
    isTest: pfandReturn.isTest,
    createdAt: iso(pfandReturn.createdAt),
  };
}

export function eventData(
  event: Pick<Event, 'id' | 'name' | 'startDate' | 'endDate' | 'status'>,
  phase: string | null,
): Record<string, unknown> {
  return {
    id: event.id,
    name: event.name,
    startDate: iso(event.startDate),
    endDate: iso(event.endDate),
    status: event.status,
    phase,
  };
}

export function closingData(
  closing: CashPointClosing,
): Record<string, unknown> {
  return {
    id: closing.id,
    registerId: closing.registerId,
    zNr: closing.zNr,
    businessDate: closing.businessDate,
    periodFrom: iso(closing.periodFrom),
    periodTo: iso(closing.periodTo),
    transactionCount: closing.transactionCount,
    trigger: closing.trigger,
    createdAt: iso(closing.closingCreatedAt ?? closing.createdAt),
  };
}

export function productData(
  product: Product,
  options: PayloadOptions,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    id: product.id,
    eventId: product.eventId,
    categoryId: product.categoryId,
    name: product.name,
  };
  if (!options.ordersOnly) {
    data.price = money(product.price);
    data.taxRate = Number(product.taxRate);
  }
  data.isActive = product.isActive;
  data.isAvailable = product.isAvailable;
  data.trackInventory = product.trackInventory;
  data.stockQuantity = product.stockQuantity;
  data.deleted = !!product.deletedAt;
  return data;
}

export interface WebhookEnvelope {
  id: string;
  type: WebhookEventType | 'ping';
  apiVersion: string;
  createdAt: string;
  organizationId: string;
  data: Record<string, unknown>;
}

export function envelope(
  eventId: string,
  type: WebhookEventType | 'ping',
  organizationId: string,
  createdAt: Date,
  data: Record<string, unknown>,
): WebhookEnvelope {
  return {
    id: eventId,
    type,
    apiVersion: WEBHOOK_API_VERSION,
    createdAt: createdAt.toISOString(),
    organizationId,
    data,
  };
}
