import { ForbiddenException } from '@nestjs/common';

import { OrdersService } from './orders.service';
import { PaymentsService } from '../payments/payments.service';
import { mayManageOrders } from './order-permissions';
import {
  OrderStatus,
  PaymentStatus,
} from '../../database/entities/order.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { PaymentMethod } from '../../database/entities/payment.entity';
import type { User } from '../../database/entities';
import type { CreatePaymentDto, SplitPaymentDto } from '../payments/dto';

type Row = Record<string, unknown>;

const ORG = 'org-1';
const user = { id: 'user-1', isSuperAdmin: false } as User;

const member = { role: OrganizationRole.MEMBER, permissions: {} };
const withOrders = {
  role: OrganizationRole.MEMBER,
  permissions: { orders: true },
};
const admin = { role: OrganizationRole.ADMIN, permissions: {} };

describe('mayManageOrders', () => {
  it('allows admins, members with the orders permission and super admins', () => {
    expect(mayManageOrders(user, admin)).toBe(true);
    expect(mayManageOrders(user, withOrders)).toBe(true);
    expect(mayManageOrders({ isSuperAdmin: true }, null)).toBe(true);
  });

  it('denies members without the orders permission', () => {
    expect(mayManageOrders(user, member)).toBe(false);
    expect(
      mayManageOrders(user, {
        role: OrganizationRole.MEMBER,
        permissions: { products: true },
      }),
    ).toBe(false);
    expect(mayManageOrders(user, null)).toBe(false);
  });
});

/** OrdersService mit einer Bestellung im Speicher. */
function ordersService(membership: Row, order: Row) {
  const orderRepository = {
    save: jest.fn((o: Row) => Promise.resolve(o)),
    softRemove: jest.fn(() => Promise.resolve()),
  };
  const orderItemRepository = {
    save: jest.fn((i: Row) => Promise.resolve(i)),
    remove: jest.fn(() => Promise.resolve()),
  };
  const organizationRepository = {
    findOne: jest.fn(() => Promise.resolve({ id: ORG, settings: {} })),
  };
  const none = undefined as never;
  const service = new OrdersService(
    orderRepository as never,
    orderItemRepository as never,
    none,
    organizationRepository as never,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
  );
  const internals = service as unknown as Record<string, unknown>;
  internals.checkMembership = jest.fn(() => Promise.resolve(membership));
  internals.findOne = jest.fn(() => Promise.resolve(order));
  internals.restoreStockForItem = jest.fn(() => Promise.resolve());
  internals.recalculateOrderTotals = jest.fn(() => Promise.resolve());
  internals.updateOrderStatus = jest.fn(() => Promise.resolve());
  internals.shouldChargePfand = jest.fn(() => Promise.resolve(false));
  internals.addItemToOrder = jest.fn(() =>
    Promise.resolve({ id: 'new', quantity: 1 }),
  );
  return { service, orderRepository, orderItemRepository };
}

const pendingItem = {
  id: 'item-1',
  status: 'pending',
  quantity: 2,
  paidQuantity: 0,
  unitPrice: 3,
  optionsPrice: 0,
  productName: 'Wasser',
};

const openOrder = (paymentStatus: PaymentStatus): Row => ({
  id: 'order-1',
  orderNumber: 'N-1',
  status: OrderStatus.IN_PROGRESS,
  paymentStatus,
  closedWithoutPaymentAt: null,
  eventId: null,
  items: [{ ...pendingItem }],
});

const DENIED = { response: { reason: 'ORDERS_PERMISSION_REQUIRED' } };

describe('OrdersService — orders permission', () => {
  it('requires the orders permission to delete orders', async () => {
    const t = ordersService(member, openOrder(PaymentStatus.UNPAID));
    await expect(t.service.remove(ORG, 'order-1', user)).rejects.toMatchObject(
      DENIED,
    );
    expect(t.orderRepository.softRemove).not.toHaveBeenCalled();
  });

  it('members with the orders permission delete unpaid orders', async () => {
    const t = ordersService(withOrders, openOrder(PaymentStatus.UNPAID));
    await t.service.remove(ORG, 'order-1', user);
    expect(t.orderRepository.softRemove).toHaveBeenCalled();
  });

  it('members edit unpaid orders as before', async () => {
    const t = ordersService(member, openOrder(PaymentStatus.UNPAID));
    await t.service.update(ORG, 'order-1', { notes: 'Tisch 4' }, user);
    expect(t.orderRepository.save).toHaveBeenCalled();
  });

  it.each([PaymentStatus.PARTLY_PAID, PaymentStatus.PAID])(
    'requires the orders permission to edit %s orders',
    async (status) => {
      const t = ordersService(member, openOrder(status));
      await expect(
        t.service.update(ORG, 'order-1', { discountAmount: 5 }, user),
      ).rejects.toMatchObject(DENIED);
      await expect(
        t.service.addItem(
          ORG,
          'order-1',
          { productId: 'p-1', quantity: 1 } as never,
          user,
        ),
      ).rejects.toMatchObject(DENIED);
      await expect(
        t.service.updateItem(ORG, 'order-1', 'item-1', { quantity: 1 }, user),
      ).rejects.toMatchObject(DENIED);
      await expect(
        t.service.removeItem(ORG, 'order-1', 'item-1', user),
      ).rejects.toMatchObject(DENIED);
      expect(t.orderRepository.save).not.toHaveBeenCalled();
      expect(t.orderItemRepository.save).not.toHaveBeenCalled();
      expect(t.orderItemRepository.remove).not.toHaveBeenCalled();
    },
  );

  it('requires the orders permission to edit orders closed without payment', async () => {
    const t = ordersService(member, {
      ...openOrder(PaymentStatus.UNPAID),
      closedWithoutPaymentAt: new Date(),
    });
    await expect(
      t.service.update(ORG, 'order-1', { notes: 'x' }, user),
    ).rejects.toMatchObject(DENIED);
  });

  it('admins edit partly paid orders', async () => {
    const t = ordersService(admin, openOrder(PaymentStatus.PARTLY_PAID));
    await t.service.update(ORG, 'order-1', { notes: 'x' }, user);
    expect(t.orderRepository.save).toHaveBeenCalled();
  });
});

describe('PaymentsService — orders permission', () => {
  function paymentsService(membership: Row) {
    const paymentRepository = {
      create: jest.fn((p: Row) => p),
      save: jest.fn(() => Promise.resolve()),
    };
    const orderRepository = { findOne: jest.fn() };
    const userOrganizationRepository = {
      findOne: jest.fn(() => Promise.resolve(membership)),
    };
    const none = undefined as never;
    const service = new PaymentsService(
      paymentRepository as never,
      orderRepository as never,
      none,
      none,
      userOrganizationRepository as never,
      none,
      none,
    );
    return { service, paymentRepository, orderRepository };
  }

  const paymentDto = {
    orderId: 'order-1',
    amount: 5,
    paymentMethod: PaymentMethod.CASH,
  } as CreatePaymentDto;
  const splitDto = {
    orderId: 'order-1',
    amount: 3,
    paymentMethod: PaymentMethod.CASH,
    items: [{ orderItemId: 'item-1', quantity: 1 }],
  } as SplitPaymentDto;

  it('requires the orders permission to record a payment', async () => {
    const t = paymentsService(member);
    await expect(
      t.service.create(ORG, paymentDto, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      t.service.createSplitPayment(ORG, splitDto, user),
    ).rejects.toMatchObject(DENIED);
    expect(t.orderRepository.findOne).not.toHaveBeenCalled();
    expect(t.paymentRepository.save).not.toHaveBeenCalled();
  });

  it('members with the orders permission get past the permission check', async () => {
    const t = paymentsService(withOrders);
    // Organisation fehlt im Mock: der naechste Schritt (Betriebsart) greift.
    (t.service as unknown as Record<string, unknown>).assertPaymentsAllowedFor =
      jest.fn(() => Promise.resolve());
    t.orderRepository.findOne.mockResolvedValue(null);
    await expect(t.service.create(ORG, paymentDto, user)).rejects.toMatchObject(
      { response: { reason: 'ORDER_NOT_FOUND' } },
    );
  });
});
