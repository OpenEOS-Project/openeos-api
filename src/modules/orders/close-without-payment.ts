import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  isCashBlockedByPolicy,
  type CashPolicyOrg,
} from '../../common/utils/cash-policy.util';
import {
  handOverOnCompletion,
  itemsStillInProduction,
} from '../../common/utils/operating-mode.util';
import {
  Order,
  OrderStatus,
  PaymentStatus,
} from '../../database/entities/order.entity';
import { OrderItem } from '../../database/entities/order-item.entity';

/**
 * „Ohne Zahlung abschließen“ (Bargeld-Regel „Deutschland ohne Bargeld“).
 *
 * Kann eine Organisation in OpenEOS kein Bargeld erfassen (DE ohne TSE,
 * cash-policy.util.ts), kassiert sie Bargeld ausserhalb, z. B. in einer
 * offenen Ladenkasse. Die Bestellung in OpenEOS wird dann ohne Zahlung
 * abgeschlossen: keine Zahlungszeile, kein bezahlter Betrag
 * (`paidAmount` und `paymentStatus` bleiben, wie sie sind), nur der
 * Zeitpunkt in `closed_without_payment_at`.
 *
 * Danach wirkt die Bestellung wie bezahlt — nur eben ohne Geld in OpenEOS:
 * - Sie ist nicht mehr offen fuer eine Zahlung (offene Bestellungen,
 *   Tische, Kassieren → 409 ORDER_CLOSED_WITHOUT_PAYMENT).
 * - Abgeschlossen ist sie sofort, wenn keine Station mehr daran arbeitet;
 *   sonst mit der Ausgabe der letzten Stationsposition (wie eine bezahlte
 *   Bestellung). Positionen ohne Station und fertige Stationspositionen
 *   gelten beim Abschluss als ausgegeben — wie im Modus „Nur Bestellen“.
 */

/** 403, wenn die Organisation Bargeld in OpenEOS erfassen kann. */
export function assertCloseWithoutPaymentAllowed(
  org: CashPolicyOrg | null | undefined,
): void {
  if (isCashBlockedByPolicy(org)) return;
  throw new ForbiddenException({
    code: ErrorCodes.FORBIDDEN,
    reason: ErrorReasons.CLOSE_WITHOUT_PAYMENT_NOT_AVAILABLE,
    message:
      '„Ohne Zahlung abschließen“ gibt es nur, wenn deine Organisation in OpenEOS kein Bargeld erfassen kann. Kassiere die Bestellung bitte.',
  });
}

/** 409 fuer jeden Zahlungsversuch auf eine ohne Zahlung abgeschlossene Bestellung. */
export function closedWithoutPaymentError(
  orderIds: string[],
): ConflictException {
  return new ConflictException({
    code: ErrorCodes.VALIDATION_ERROR,
    reason: ErrorReasons.ORDER_CLOSED_WITHOUT_PAYMENT,
    message:
      'Diese Bestellung wurde schon ohne Zahlung abgeschlossen (außerhalb von OpenEOS bezahlt). Lade die offenen Bestellungen neu.',
    params: { orderIds },
  });
}

type ItemLike = Parameters<typeof itemsStillInProduction>[0][number];

/**
 * Darf die Bestellung jetzt abschliessen? Keine Station arbeitet mehr an
 * ihr (offen oder in Zubereitung) und es gibt aktive Positionen — oder gar
 * keine Positionen mit Station.
 */
export function workflowDoneForClose(items: ItemLike[]): boolean {
  return itemsStillInProduction(items).length === 0;
}

/**
 * Schliesst Bestellungen ohne Zahlung ab (in einer laufenden Transaktion).
 * Die Pruefung der Bargeld-Regel macht der Aufrufer
 * (`assertCloseWithoutPaymentAllowed`).
 *
 * - Unbekannt → 404, storniert → 400, bezahlt → 409 ORDER_ALREADY_PAID.
 * - Schon abgeschlossene oder schon ohne Zahlung abgeschlossene werden
 *   uebersprungen (Wiederholung nach Netzfehler).
 *
 * Liefert die geaenderten Bestellungen (mit neuem Status).
 */
export async function closeOrdersWithoutPayment(
  manager: EntityManager,
  organizationId: string,
  orderIds: string[],
  now: Date,
): Promise<Order[]> {
  const ids = Array.from(new Set(orderIds));
  if (ids.length === 0) return [];
  const orders = await manager.find(Order, {
    where: { id: In(ids), organizationId },
    order: { id: 'ASC' },
    lock: { mode: 'pessimistic_write' },
  });
  const found = new Set(orders.map((o) => o.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) {
    throw new NotFoundException({
      code: ErrorCodes.NOT_FOUND,
      reason: ErrorReasons.ORDER_NOT_FOUND,
      message: 'Bestellung nicht gefunden',
      params: { orderIds: missing },
    });
  }
  const cancelled = orders.filter((o) => o.status === OrderStatus.CANCELLED);
  if (cancelled.length) {
    throw new BadRequestException({
      code: ErrorCodes.VALIDATION_ERROR,
      reason: ErrorReasons.ORDER_CANCELLED_CANNOT_COMPLETE,
      message: 'Stornierte Bestellung kann nicht abgeschlossen werden',
      params: { orderIds: cancelled.map((o) => o.id) },
    });
  }
  const paid = orders.filter(
    (o) =>
      o.paymentStatus === PaymentStatus.PAID ||
      o.paymentStatus === PaymentStatus.REFUNDED,
  );
  if (paid.length) {
    throw new ConflictException({
      code: ErrorCodes.ORDER_ALREADY_PAID,
      reason: ErrorReasons.ORDER_ALREADY_PAID,
      message:
        'Mindestens eine Bestellung ist schon bezahlt. Lade die offenen Bestellungen neu.',
      params: { orderIds: paid.map((o) => o.id) },
    });
  }

  const items = await manager.find(OrderItem, {
    where: { orderId: In(ids) },
  });
  const changed: Order[] = [];
  for (const order of orders) {
    if (order.status === OrderStatus.COMPLETED) continue;
    if (order.closedWithoutPaymentAt) continue;
    const own = items.filter((i) => i.orderId === order.id);
    order.closedWithoutPaymentAt = now;
    const patch: {
      closedWithoutPaymentAt: Date;
      status?: OrderStatus;
      completedAt?: Date;
    } = { closedWithoutPaymentAt: now };
    if (workflowDoneForClose(own)) {
      const handedOver = handOverOnCompletion(own, now);
      if (handedOver.length) await manager.save(handedOver);
      order.status = OrderStatus.COMPLETED;
      order.completedAt = now;
      patch.status = OrderStatus.COMPLETED;
      patch.completedAt = now;
    }
    await manager.update(Order, { id: order.id }, patch);
    order.items = own;
    changed.push(order);
  }
  return changed;
}
