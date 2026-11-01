import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OrderItemStatus } from '../../database/entities/order-item.entity';
import { PaymentMethod } from '../../database/entities/payment.entity';
import {
  assertOrderOnlyCompletable,
  assertPaymentsAllowed,
  getOperatingMode,
  getOperatingModeSince,
  isOnlinePrepaymentMethod,
  isOrderOnlyMode,
  itemsStillInProduction,
  shouldAutoCompleteOrderOnly,
  stripOperatingMode,
} from './operating-mode.util';

const item = (
  status: OrderItemStatus,
  productionStationId: string | null = null,
) => ({ status, productionStationId, productName: 'Pommes' });

describe('operating mode helper', () => {
  it('is `pos` unless settings.operatingMode is exactly order_only', () => {
    expect(getOperatingMode(undefined)).toBe('pos');
    expect(getOperatingMode({})).toBe('pos');
    expect(getOperatingMode({ operatingMode: 'ORDER_ONLY' })).toBe('pos');
    expect(getOperatingMode({ operatingMode: true })).toBe('pos');
    expect(getOperatingMode({ operatingMode: 'order_only' })).toBe(
      'order_only',
    );
    expect(isOrderOnlyMode({ operatingMode: 'order_only' })).toBe(true);
    expect(
      getOperatingModeSince({ operatingModeSince: '2026-11-01T10:00:00Z' }),
    ).toBe('2026-11-01T10:00:00Z');
    expect(getOperatingModeSince({})).toBeNull();
  });

  it('rejects every payment with 403 ORDER_ONLY_MODE in order_only, nothing in pos', () => {
    expect(() => assertPaymentsAllowed({})).not.toThrow();
    let error: unknown;
    try {
      assertPaymentsAllowed({ operatingMode: 'order_only' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      code: 'ORDER_ONLY_MODE',
    });
  });

  it('only PayPal and SumUp Online count as online prepayment', () => {
    expect(isOnlinePrepaymentMethod(PaymentMethod.PAYPAL)).toBe(true);
    expect(isOnlinePrepaymentMethod(PaymentMethod.SUMUP_ONLINE)).toBe(true);
    for (const m of [
      PaymentMethod.CASH,
      PaymentMethod.CARD,
      PaymentMethod.SUMUP_TERMINAL,
      null,
    ]) {
      expect(isOnlinePrepaymentMethod(m)).toBe(false);
    }
  });

  it('strips mode and timestamp from incoming settings', () => {
    const settings = {
      vatExempt: true,
      operatingMode: 'order_only',
      operatingModeSince: 'x',
    };
    expect(stripOperatingMode(settings)).toEqual({ vatExempt: true });
    expect(stripOperatingMode(undefined)).toBeUndefined();
  });
});

describe('closing orders without payment', () => {
  it('counter orders complete once nothing is left at a station', () => {
    expect(
      shouldAutoCompleteOrderOnly('counter_pickup', [
        item(OrderItemStatus.PENDING),
      ]),
    ).toBe(true);
    expect(
      shouldAutoCompleteOrderOnly('takeaway', [
        item(OrderItemStatus.PENDING),
        item(OrderItemStatus.DELIVERED, 's1'),
        item(OrderItemStatus.CANCELLED, 's1'),
      ]),
    ).toBe(true);
    expect(
      shouldAutoCompleteOrderOnly('counter_pickup', [
        item(OrderItemStatus.READY, 's1'),
      ]),
    ).toBe(false);
    expect(
      shouldAutoCompleteOrderOnly('counter_pickup', [
        item(OrderItemStatus.CANCELLED),
      ]),
    ).toBe(false);
  });

  it('table orders never complete by themselves', () => {
    expect(
      shouldAutoCompleteOrderOnly('table_service', [
        item(OrderItemStatus.DELIVERED, 's1'),
      ]),
    ).toBe(false);
  });

  it('cannot be closed while a station is still working', () => {
    const items = [
      item(OrderItemStatus.READY, 's1'),
      item(OrderItemStatus.PREPARING, 's1'),
      item(OrderItemStatus.PENDING),
    ];
    expect(itemsStillInProduction(items)).toHaveLength(1);
    let error: unknown;
    try {
      assertOrderOnlyCompletable(items);
    } catch (e) {
      error = e;
    }
    expect((error as BadRequestException).getResponse()).toMatchObject({
      reason: 'ORDER_ITEMS_IN_PRODUCTION',
    });
    expect(() =>
      assertOrderOnlyCompletable([item(OrderItemStatus.READY, 's1')]),
    ).not.toThrow();
  });
});
