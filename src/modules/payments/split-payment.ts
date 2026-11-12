import { BadRequestException } from '@nestjs/common';

import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { OrderStatus } from '../../database/entities/order.entity';
import { OrderItemStatus } from '../../database/entities/order-item.entity';

/** Was die Aufteilung von einer Position braucht. */
export interface SplitOrderItem {
  id: string;
  productName: string;
  quantity: number;
  paidQuantity: number | null;
  unitPrice: number | string;
  optionsPrice: number | string | null;
  status: OrderItemStatus | `${OrderItemStatus}`;
}

export interface SplitOrder<I extends SplitOrderItem = SplitOrderItem> {
  status: OrderStatus | `${OrderStatus}`;
  total: number | string;
  paidAmount: number | string;
  items: I[];
}

export interface SplitLine {
  orderItemId: string;
  quantity: number;
}

export interface SplitPlan<I extends SplitOrderItem = SplitOrderItem> {
  /** Zu buchender Betrag, aus den Positionen berechnet (Cent genau). */
  amount: number;
  lines: { item: I; quantity: number; amount: number }[];
}

/** Abweichung zwischen gesendetem und berechnetem Betrag (Rundung). */
const AMOUNT_TOLERANCE = 0.01;

const cents = (value: number): number => Math.round(value * 100) / 100;

function invalid(
  reason: string,
  message: string,
  params?: Record<string, unknown>,
): BadRequestException {
  return new BadRequestException({
    code: ErrorCodes.VALIDATION_ERROR,
    reason,
    message,
    ...(params ? { params } : {}),
  });
}

/**
 * Teilzahlung nach Positionen pruefen und berechnen — gemeinsam fuer die
 * Kasse (`POST /device-api/payments/split`) und die Verwaltung
 * (`POST /organizations/:id/payments/split`).
 *
 * - Jede Position gehoert zur Bestellung und ist nicht storniert; mehrfach
 *   genannte Positionen werden zusammengezaehlt.
 * - Je Position hoechstens die noch unbezahlte Menge, ganze Stueck > 0.
 * - Der gesendete Betrag entspricht der Summe der Positionen; gebucht wird
 *   der berechnete Betrag.
 * - Die Summe uebersteigt nie den offenen Betrag der Bestellung.
 */
export function planSplitPayment<I extends SplitOrderItem>(
  order: SplitOrder<I>,
  lines: SplitLine[],
  amount: number,
): SplitPlan<I> {
  if (order.status === OrderStatus.CANCELLED) {
    throw invalid(
      ErrorReasons.ORDER_CANCELLED_CANNOT_COMPLETE,
      'Stornierte Bestellungen können nicht bezahlt werden',
    );
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    throw invalid(
      ErrorReasons.PAYMENT_AMOUNT_MISMATCH,
      'Wähle mindestens eine Position aus',
    );
  }

  const requested = new Map<string, number>();
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw invalid(
        ErrorReasons.INSUFFICIENT_UNPAID_QUANTITY,
        'Die Menge muss eine ganze Zahl größer als 0 sein',
      );
    }
    requested.set(
      line.orderItemId,
      (requested.get(line.orderItemId) ?? 0) + line.quantity,
    );
  }

  const planned: SplitPlan<I>['lines'] = [];
  for (const [orderItemId, quantity] of requested) {
    const item = order.items.find((i) => i.id === orderItemId);
    if (!item) {
      throw invalid(
        ErrorReasons.ORDER_ITEM_NOT_FOUND,
        `Bestellposition ${orderItemId} nicht gefunden`,
      );
    }
    const unpaid =
      item.status === OrderItemStatus.CANCELLED
        ? 0
        : item.quantity - (item.paidQuantity ?? 0);
    if (quantity > unpaid) {
      throw invalid(
        ErrorReasons.INSUFFICIENT_UNPAID_QUANTITY,
        `Nicht genügend unbezahlte Menge für ${item.productName} (${Math.max(unpaid, 0)} verfügbar)`,
        { product: item.productName },
      );
    }
    const unitPrice = Number(item.unitPrice) + Number(item.optionsPrice || 0);
    planned.push({ item, quantity, amount: cents(unitPrice * quantity) });
  }

  const expected = cents(planned.reduce((sum, l) => sum + l.amount, 0));
  if (
    !Number.isFinite(amount) ||
    Math.abs(amount - expected) > AMOUNT_TOLERANCE
  ) {
    throw invalid(
      ErrorReasons.PAYMENT_AMOUNT_MISMATCH,
      `Berechneter Betrag (${expected.toFixed(2)}) stimmt nicht mit dem Zahlungsbetrag (${amount}) überein`,
      { expected: expected.toFixed(2), received: amount },
    );
  }

  if (expected < 0.01) {
    throw invalid(
      ErrorReasons.PAYMENT_AMOUNT_MISMATCH,
      'Die gewählten Positionen ergeben keinen zu zahlenden Betrag',
      { expected: expected.toFixed(2), received: amount },
    );
  }

  const remaining = cents(Number(order.total) - Number(order.paidAmount));
  if (expected > remaining + 0.005) {
    throw invalid(
      ErrorReasons.PAYMENT_EXCEEDS_REMAINING,
      `Die Positionen (${expected.toFixed(2)}) übersteigen den offenen Betrag (${remaining.toFixed(2)}). Kassiere den Rest ohne Aufteilung.`,
      { amount: expected, remaining },
    );
  }

  return { amount: expected, lines: planned };
}
