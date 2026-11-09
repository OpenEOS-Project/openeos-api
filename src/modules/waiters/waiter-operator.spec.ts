import { OrganizationRole } from '../../database/entities/user-organization.entity';
import {
  attributionOf,
  effectiveWaiterPermissions,
  memberOperator,
  waiterModeOf,
  waiterOperator,
  waiterSettings,
} from './waiter-operator';
import { normalizeWaiterSettings } from './waiter-settings';
import { assertOperatorMay } from './waiter-sessions.service';
import { ErrorReasons } from '../../common/constants/error-codes';

describe('waiter operator helpers', () => {
  it('maps the former requirePin switch to the shared mode', () => {
    expect(waiterModeOf(undefined)).toBe('off');
    expect(waiterModeOf({})).toBe('off');
    expect(waiterModeOf({ requirePin: true })).toBe('shared');
    expect(waiterModeOf({ requirePin: true, waiterMode: 'off' })).toBe('off');
    expect(waiterModeOf({ waiterMode: 'personal' })).toBe('personal');
    expect(waiterModeOf({ waiterMode: 'bogus' as never })).toBe('off');
  });

  it('derives permissions from role and overrides', () => {
    expect(effectiveWaiterPermissions('service', {})).toEqual({
      refund: false,
      cashDrawer: false,
      discount: true,
      cashbook: false,
    });
    expect(effectiveWaiterPermissions('lead', {})).toEqual({
      refund: true,
      cashDrawer: true,
      discount: true,
      cashbook: true,
    });
    expect(
      effectiveWaiterPermissions('service', {
        refund: true,
        discount: false,
        bogus: true,
      } as never),
    ).toEqual({
      refund: true,
      cashDrawer: false,
      discount: false,
      cashbook: false,
    });
  });

  it('gives members the rights they had at the till (refund only with orders/admin)', () => {
    const member = memberOperator(
      { userId: 'u1', role: OrganizationRole.MEMBER, permissions: {} },
      { firstName: 'Markus', lastName: 'Maier' },
      's1',
    );
    expect(member).toMatchObject({
      kind: 'member',
      userId: 'u1',
      waiterId: null,
      name: 'Markus Maier',
      shortName: 'Markus',
      role: 'member',
      sessionId: 's1',
    });
    expect(member.permissions.refund).toBe(false);
    expect(
      memberOperator(
        {
          userId: 'u1',
          role: OrganizationRole.MEMBER,
          permissions: { orders: true },
        },
        { firstName: 'M', lastName: '' },
        null,
      ).permissions.refund,
    ).toBe(true);
    expect(
      memberOperator(
        { userId: 'u1', role: OrganizationRole.ADMIN, permissions: {} },
        {},
        null,
      ),
    ).toMatchObject({
      role: 'admin',
      name: '—',
      permissions: { refund: true },
    });
  });

  it('attributes bookings to the waiter or member of the session', () => {
    const waiter = waiterOperator(
      {
        id: 'w1',
        name: 'Anna Berger',
        shortName: 'Anna',
        color: '#2563eb',
        role: 'service',
        permissions: {},
      },
      's1',
    );
    expect(attributionOf(waiter)).toEqual({
      waiterId: 'w1',
      userId: null,
      name: 'Anna Berger',
    });
    expect(attributionOf(null)).toEqual({
      waiterId: null,
      userId: null,
      name: null,
    });
  });

  it('checks a permission only when someone is logged in', () => {
    const waiter = waiterOperator(
      {
        id: 'w1',
        name: 'A',
        shortName: null,
        color: null,
        role: 'service',
        permissions: {},
      },
      null,
    );
    expect(() => assertOperatorMay(null, 'cashbook')).not.toThrow();
    expect(() => assertOperatorMay(waiter, 'discount')).not.toThrow();
    let reason: unknown;
    try {
      assertOperatorMay(waiter, 'cashbook');
    } catch (error) {
      reason = (
        error as { getResponse(): { reason: string; params: unknown } }
      ).getResponse();
    }
    expect(reason).toMatchObject({
      reason: ErrorReasons.WAITER_NOT_PERMITTED,
      params: { permission: 'cashbook' },
    });
  });

  it('keeps the waiter wallet off until the tax advisor answered (SB1)', () => {
    expect(
      waiterSettings({ settings: { waiters: { wallet: true } } } as never),
    ).toEqual({
      pinLength: 4,
      wallet: false,
      foreignTables: 'warn',
      selfSettlement: false,
      receiptName: 'short',
    });
    expect(
      waiterSettings({
        settings: {
          waiters: {
            pinLength: 6,
            foreignTables: 'allow',
            receiptName: 'full',
          },
        },
      } as never),
    ).toMatchObject({
      pinLength: 6,
      foreignTables: 'allow',
      receiptName: 'full',
    });
  });

  it('validates the organization waiter settings', () => {
    expect(
      normalizeWaiterSettings({ pinLength: 6, wallet: true, extra: 1 }),
    ).toEqual({
      pinLength: 6,
      wallet: false,
    });
    expect(normalizeWaiterSettings(null)).toBeUndefined();
    expect(() => normalizeWaiterSettings({ pinLength: 5 })).toThrow();
    expect(() => normalizeWaiterSettings({ foreignTables: 'deny' })).toThrow();
    expect(() => normalizeWaiterSettings('x')).toThrow();
  });
});
