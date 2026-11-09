import {
  buildSettlementTotals,
  methodGroup,
  settlementIsEmpty,
  settlementIsTrainingOnly,
  type SettlementInput,
} from './waiter-settlement-math';
import {
  settlementBlocks,
  summaryPrintData,
} from './waiter-settlements.service';
import { waiterAnonymizeDueAt } from './waiter-retention';

const input = (over: Partial<SettlementInput> = {}): SettlementInput => ({
  operatingMode: 'full',
  payments: [],
  refunds: [],
  pfandReturns: [],
  taken: [],
  items: [],
  ...over,
});

describe('Kellnerabrechnung (Rechnung)', () => {
  it('groups payment methods into cash, card and other', () => {
    expect(methodGroup('cash')).toBe('cash');
    expect(methodGroup('card')).toBe('card');
    expect(methodGroup('sumup_terminal')).toBe('card');
    for (const m of ['sumup_online', 'paypal', 'apple_pay', 'google_pay']) {
      expect(methodGroup(m)).toBe('other');
    }
  });

  it('computes expected cash per drawer: cash payments minus cash refunds and deposits', () => {
    const totals = buildSettlementTotals(
      input({
        payments: [
          {
            method: 'cash',
            isTest: false,
            deviceId: 'a',
            deviceName: 'Theke',
            count: '2',
            amount: '12.30',
            tip: '0.70',
          },
          {
            method: 'cash',
            isTest: false,
            deviceId: 'b',
            deviceName: 'Zelt',
            count: 1,
            amount: 4.5,
            tip: 0,
          },
          {
            method: 'sumup_terminal',
            isTest: false,
            deviceId: 'b',
            deviceName: 'Zelt',
            count: 1,
            amount: 20,
            tip: 2,
          },
          {
            method: 'paypal',
            isTest: false,
            deviceId: null,
            deviceName: null,
            count: 1,
            amount: 9.9,
            tip: 0,
          },
          {
            method: 'cash',
            isTest: true,
            deviceId: 'a',
            deviceName: 'Theke',
            count: 3,
            amount: 99,
            tip: 5,
          },
        ],
        refunds: [
          {
            method: 'cash',
            isTest: false,
            deviceId: 'a',
            deviceName: 'Theke',
            count: 1,
            amount: '-2.10',
          },
          { method: 'sumup_terminal', isTest: false, count: 1, amount: -20 },
          { method: 'cash', isTest: true, count: 1, amount: -99 },
        ],
        pfandReturns: [
          {
            isTest: false,
            deviceId: 'b',
            deviceName: 'Zelt',
            count: 2,
            amount: '4.00',
          },
          { isTest: true, count: 1, amount: 2 },
        ],
        taken: [
          { isTest: false, orders: 3, discounts: '1.50' },
          { isTest: true, orders: 2, discounts: 0 },
        ],
        items: [
          { isTest: false, items: '7', revenue: '38.20' },
          { isTest: true, items: 4, revenue: 99 },
        ],
      }),
    );
    expect(totals.payments).toEqual({
      cash: { count: 3, amount: 16.8 },
      card: { count: 1, amount: 20 },
      other: { count: 1, amount: 9.9 },
      total: { count: 5, amount: 46.7 },
    });
    expect(totals.tips).toBe(2.7);
    expect(totals.refunds).toEqual({
      cash: { count: 1, amount: 2.1 },
      nonCash: { count: 1, amount: 20 },
      total: { count: 2, amount: 22.1 },
    });
    expect(totals.pfandReturns).toEqual({ count: 2, amount: 4 });
    expect(totals.cashExpected).toBe(10.7);
    expect(totals.cashByDevice).toEqual([
      { deviceId: 'a', deviceName: 'Theke', amount: 10.2 },
      { deviceId: 'b', deviceName: 'Zelt', amount: 0.5 },
    ]);
    expect(totals.taken).toEqual({
      orders: 3,
      items: 7,
      revenue: 38.2,
      discounts: 1.5,
    });
    expect(totals.training).toEqual({ orders: 2, payments: 3, amount: 99 });
    expect(settlementIsEmpty(totals)).toBe(false);
    expect(settlementIsTrainingOnly(totals)).toBe(false);
  });

  it('knows empty and training-only periods', () => {
    expect(settlementIsEmpty(buildSettlementTotals(input()))).toBe(true);
    const training = buildSettlementTotals(
      input({ taken: [{ isTest: true, orders: 1, discounts: 0 }] }),
    );
    expect(settlementIsEmpty(training)).toBe(false);
    expect(settlementIsTrainingOnly(training)).toBe(true);
  });

  it('keeps only quantities in the „Nur Bons“ mode', () => {
    const totals = buildSettlementTotals(
      input({
        operatingMode: 'orders_only',
        payments: [
          {
            method: 'cash',
            isTest: false,
            deviceId: null,
            deviceName: null,
            count: 1,
            amount: 3,
            tip: 0,
          },
        ],
        taken: [{ isTest: false, orders: 2, discounts: 0 }],
        items: [{ isTest: false, items: 5, revenue: 17 }],
      }),
    );
    expect(totals).toEqual({
      operatingMode: 'orders_only',
      taken: { orders: 2, items: 5 },
      training: { orders: 0, payments: 0 },
    });
    expect(JSON.stringify(settlementBlocks(totals))).not.toMatch(/amount":\d/);
  });

  it('prints an informational summary without number and signatures', () => {
    const totals = buildSettlementTotals(
      input({
        payments: [
          {
            method: 'cash',
            isTest: false,
            deviceId: 'a',
            deviceName: 'Theke',
            count: 1,
            amount: 5,
            tip: 0,
          },
        ],
      }),
    );
    const data = summaryPrintData(
      {
        subject: {
          kind: 'waiter',
          id: 'w',
          waiterId: 'w',
          userId: null,
          name: 'Anna',
          shortName: null,
          color: null,
          anonymized: false,
        },
        eventId: 'e',
        eventName: 'Sommerfest',
        periodFrom: null,
        periodTo: new Date('2026-07-11T18:30:00Z'),
        totals,
        openTables: [
          {
            orderId: 'o',
            orderNumber: 'A-1',
            dailyNumber: 4,
            tableNumber: '7',
            openAmount: 12.5,
          },
        ],
        wallet: false,
        lastSettlement: null,
        empty: false,
      },
      'Kasse Theke',
    );
    expect(data).toMatchObject({
      title: 'ZWISCHENSTAND',
      number: null,
      signatures: false,
      period_to: '11.07.2026 20:30',
      cash_expected: 5,
      cash_by_device: [{ name: 'Theke', amount: 5 }],
      open_tables: [{ label: 'Tisch 7: 12,50' }],
    });
  });
});

describe('Bedienungen: Frist bis zur Anonymisierung', () => {
  const periods = { dataDays: 30, inactiveMonths: 12, sessionDays: 90 };
  const base = {
    isActive: true,
    deactivatedAt: null,
    lastUsedAt: null,
    createdAt: new Date('2026-01-10T10:00:00Z'),
    anonymizedAt: null,
  };

  it('event-bound: 30 days after the end (or deletion) of the event', () => {
    expect(
      waiterAnonymizeDueAt(
        { ...base, eventId: 'e' },
        { end_date: '2026-07-12T22:00:00Z', deleted_at: null },
        periods,
      ),
    ).toEqual(new Date('2026-08-11T22:00:00Z'));
    expect(
      waiterAnonymizeDueAt(
        { ...base, eventId: 'e' },
        {
          end_date: '2026-07-12T22:00:00Z',
          deleted_at: '2026-07-01T00:00:00Z',
        },
        periods,
      ),
    ).toEqual(new Date('2026-07-31T00:00:00Z'));
    expect(
      waiterAnonymizeDueAt(
        { ...base, eventId: 'e' },
        { end_date: null, deleted_at: null },
        periods,
      ),
    ).toBeNull();
  });

  it('organisation-wide: 12 months without use or 30 days after deactivation', () => {
    expect(
      waiterAnonymizeDueAt(
        {
          ...base,
          eventId: null,
          lastUsedAt: new Date('2026-03-01T00:00:00Z'),
        },
        null,
        periods,
      ),
    ).toEqual(new Date('2027-03-01T00:00:00Z'));
    expect(
      waiterAnonymizeDueAt(
        {
          ...base,
          eventId: null,
          isActive: false,
          deactivatedAt: new Date('2026-05-01T00:00:00Z'),
        },
        null,
        periods,
      ),
    ).toEqual(new Date('2026-05-31T00:00:00Z'));
    expect(
      waiterAnonymizeDueAt(
        { ...base, eventId: null, anonymizedAt: new Date() },
        null,
        periods,
      ),
    ).toBeNull();
  });
});
