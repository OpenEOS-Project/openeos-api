/**
 * Ereignisse der ausgehenden Webhooks. Die Namen sind Teil der
 * oeffentlichen Schnittstelle: nie umbenennen, nur ergaenzen. Aendert sich
 * die Form von `data` unvertraeglich, steigt `WEBHOOK_API_VERSION`.
 */
export const WEBHOOK_API_VERSION = '2026-11-10';

export const WEBHOOK_EVENT_TYPES = [
  'order.created',
  'order.paid',
  'order.completed',
  'order.cancelled',
  'payment.created',
  'refund.created',
  'shop.order.created',
  'pfand_return.created',
  'event.activated',
  'event.phase_changed',
  'cash_point_closing.created',
  'product.updated',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** Nur ueber „Test senden“, nicht abonnierbar. */
export const WEBHOOK_PING = 'ping';

export type WebhookEventGroup =
  | 'orders'
  | 'payments'
  | 'shop'
  | 'pfand'
  | 'events'
  | 'fiscal'
  | 'catalog';

export interface WebhookEventTypeInfo {
  type: WebhookEventType;
  group: WebhookEventGroup;
  description: string;
  /** Enthaelt Betraege (in „Nur Bons“ ohne bzw. gar nicht gesendet). */
  containsAmounts: boolean;
}

export const WEBHOOK_EVENT_TYPE_INFO: readonly WebhookEventTypeInfo[] = [
  {
    type: 'order.created',
    group: 'orders',
    description: 'Eine Bestellung wurde angelegt (Kasse, Tisch, QR oder Shop).',
    containsAmounts: true,
  },
  {
    type: 'order.paid',
    group: 'orders',
    description: 'Eine Bestellung ist vollständig bezahlt.',
    containsAmounts: true,
  },
  {
    type: 'order.completed',
    group: 'orders',
    description:
      'Eine Bestellung ist abgeschlossen (ausgegeben bzw. erledigt).',
    containsAmounts: true,
  },
  {
    type: 'order.cancelled',
    group: 'orders',
    description: 'Eine Bestellung wurde storniert.',
    containsAmounts: true,
  },
  {
    type: 'payment.created',
    group: 'payments',
    description:
      'Eine Zahlung ist eingegangen (bar, Karte oder online; bei geteilten Rechnungen je Teilzahlung).',
    containsAmounts: true,
  },
  {
    type: 'refund.created',
    group: 'payments',
    description:
      'Eine Erstattung oder ein Storno mit Rückzahlung wurde gebucht.',
    containsAmounts: true,
  },
  {
    type: 'shop.order.created',
    group: 'shop',
    description:
      'Eine Bestellung ist über den Online-Shop eingegangen (bezahlt).',
    containsAmounts: true,
  },
  {
    type: 'pfand_return.created',
    group: 'pfand',
    description: 'Eine Pfandrückgabe wurde gebucht.',
    containsAmounts: true,
  },
  {
    type: 'event.activated',
    group: 'events',
    description: 'Eine Veranstaltung wurde aktiviert (nach der Freischaltung).',
    containsAmounts: false,
  },
  {
    type: 'event.phase_changed',
    group: 'events',
    description:
      'Die Phase einer Veranstaltung hat gewechselt (z. B. Geplant → Aktiv → Beendet).',
    containsAmounts: false,
  },
  {
    type: 'cash_point_closing.created',
    group: 'fiscal',
    description:
      'Ein Kassenabschluss (DSFinV-K) wurde erstellt – nur mit Cloud-TSE.',
    containsAmounts: false,
  },
  {
    type: 'product.updated',
    group: 'catalog',
    description:
      'Ein Produkt wurde geändert (Name, Preis, Steuersatz, Verfügbarkeit, Kategorie) oder gelöscht – nicht bei Bestandsänderungen durch Verkäufe.',
    containsAmounts: true,
  },
];

export function isWebhookEventType(value: unknown): value is WebhookEventType {
  return (
    typeof value === 'string' &&
    (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value)
  );
}

/** Ereignisse, die nur mit Geld entstehen: in „Nur Bons“ gar nicht gesendet. */
export const MONEY_ONLY_EVENT_TYPES: readonly WebhookEventType[] = [
  'payment.created',
  'refund.created',
];
