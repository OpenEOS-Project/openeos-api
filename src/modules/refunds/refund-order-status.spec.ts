import { OrderItemStatus } from '../../database/entities/order-item.entity';
import {
  OrderStatus,
  PaymentStatus,
} from '../../database/entities/order.entity';
import { RefundsService } from './refunds.service';

/**
 * Storno einer Position: der Bestellstatus folgt derselben Regel wie
 * Kueche und Ausgabe (`orderStatusFromItems`) — Positionen ohne Station
 * halten „fertig“ nicht auf.
 */
describe('RefundsService.finishOrderState', () => {
  const none = undefined as never;
  const service = new RefundsService(
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
  ) as unknown as {
    finishOrderState: (
      order: Record<string, unknown>,
      items: Record<string, unknown>[],
      cancelled: { orderCancelled: boolean },
      reason: string | null,
    ) => void;
  };

  const order = () => ({
    status: OrderStatus.IN_PROGRESS,
    paymentStatus: PaymentStatus.UNPAID,
    paidAmount: 0,
    total: 5,
    readyAt: null as Date | null,
    closedWithoutPaymentAt: null,
  });

  it('cancelling the open station item leaves the order ready', () => {
    const o = order();
    service.finishOrderState(
      o,
      [
        { status: OrderItemStatus.READY, productionStationId: 's1' },
        { status: OrderItemStatus.CANCELLED, productionStationId: 's1' },
        { status: OrderItemStatus.PENDING, productionStationId: null },
      ],
      { orderCancelled: false },
      null,
    );
    expect(o.status).toBe(OrderStatus.READY);
    expect(o.readyAt).toBeInstanceOf(Date);
  });

  it('stays in progress while a station item is open', () => {
    const o = order();
    service.finishOrderState(
      o,
      [
        { status: OrderItemStatus.READY, productionStationId: 's1' },
        { status: OrderItemStatus.PREPARING, productionStationId: 's1' },
        { status: OrderItemStatus.CANCELLED, productionStationId: null },
      ],
      { orderCancelled: false },
      null,
    );
    expect(o.status).toBe(OrderStatus.IN_PROGRESS);
    expect(o.readyAt).toBeNull();
  });
});
