import { EntityManager, Repository } from 'typeorm';
import { Order } from '../../database/entities/order.entity';
import { Organization } from '../../database/entities/organization.entity';
import {
  DEFAULT_ORDER_TIME_ZONE,
  ORDER_NUMBER_LOCK_NAMESPACE,
  allocateOrderNumbers,
  formatOrderNumber,
  orderDay,
  resolveOrderTimeZone,
  saveOrderWithNumbers,
} from './order-numbering';

const ORG = '7674b82d-c403-4667-8d32-00bc36195102';
const OTHER_ORG = '11111111-1111-4111-8111-111111111111';
const EVENT = '7f13dd80-e679-4427-8d3f-6b451616ef56';
const OTHER_EVENT = '22222222-2222-4222-8222-222222222222';

interface Row {
  organizationId: string;
  eventId: string | null;
  orderNumber: string;
  dailyNumber: number;
  createdAt: Date;
}

/**
 * Minimal stand-in for the EntityManager: answers the two MAX queries from
 * an in-memory table the way Postgres would, and serialises
 * pg_advisory_xact_lock per key until the transaction ends.
 */
class FakeDb {
  rows: Row[] = [];
  timeZones = new Map<string, string>();
  lockCalls: unknown[][] = [];
  private locks = new Map<string, Promise<void>>();

  manager(release?: { fn?: () => void }): EntityManager {
    const manager = {
      findOne: (entity: unknown, options: { where: { id: string } }) => {
        expect(entity).toBe(Organization);
        const tz = this.timeZones.get(options.where.id);
        return Promise.resolve(
          tz === undefined
            ? { id: options.where.id, settings: {} }
            : { id: options.where.id, settings: { timezone: tz } },
        );
      },
      query: async (sql: string, params: unknown[]) => {
        if (sql.includes('pg_advisory_xact_lock')) {
          this.lockCalls.push(params);
          const key = String(params[1]);
          const previous = this.locks.get(key) ?? Promise.resolve();
          let unlock!: () => void;
          const held = new Promise<void>((resolve) => (unlock = resolve));
          this.locks.set(
            key,
            previous.then(() => held),
          );
          await previous;
          if (release) release.fn = unlock;
          return [];
        }
        if (sql.includes('MAX(o.daily_number)')) {
          const [org, eventId, start, end] = params as [
            string,
            string | null,
            Date,
            Date,
          ];
          const values = this.rows
            .filter(
              (r) =>
                r.organizationId === org &&
                (eventId === null || r.eventId === eventId) &&
                r.createdAt >= start &&
                r.createdAt < end,
            )
            .map((r) => r.dailyNumber);
          return [{ max: values.length ? Math.max(...values) : null }];
        }
        if (sql.includes('o.order_number LIKE')) {
          const [org, like, from, start, end] = params as [
            string,
            string,
            number,
            Date,
            Date,
          ];
          const base = like.slice(0, -1);
          expect(from).toBe(base.length + 1);
          const values = this.rows
            .filter(
              (r) =>
                r.organizationId === org &&
                r.orderNumber.startsWith(base) &&
                r.createdAt >= start &&
                r.createdAt < end,
            )
            .map((r) => r.orderNumber.slice(from - 1))
            .filter((suffix) => /^[0-9]{1,9}$/.test(suffix))
            .map(Number);
          // Postgres returns integers from MAX(...) as numbers.
          return [{ max: values.length ? Math.max(...values) : null }];
        }
        throw new Error(`unexpected query: ${sql}`);
      },
      create: (_entity: unknown, data: Partial<Order>) => ({ ...data }),
      save: (order: Order) => {
        this.rows.push({
          organizationId: order.organizationId,
          eventId: order.eventId,
          orderNumber: order.orderNumber,
          dailyNumber: order.dailyNumber,
          createdAt: order.createdAt,
        });
        return Promise.resolve(order);
      },
    };
    return manager as unknown as EntityManager;
  }

  repository(): Repository<Order> {
    return {
      manager: {
        transaction: async <T>(
          work: (manager: EntityManager) => Promise<T>,
        ): Promise<T> => {
          const release: { fn?: () => void } = {};
          try {
            return await work(this.manager(release));
          } finally {
            release.fn?.();
          }
        },
      },
    } as unknown as Repository<Order>;
  }

  add(orderNumber: string, createdAt: string, extra: Partial<Row> = {}): void {
    this.rows.push({
      organizationId: ORG,
      eventId: EVENT,
      dailyNumber: 1,
      orderNumber,
      createdAt: new Date(createdAt),
      ...extra,
    });
  }
}

describe('orderDay', () => {
  it('uses the local calendar day, not the UTC day', () => {
    // 24.09. 23:59:45 and 25.09. 00:00:02 in Berlin — both 24.09. in UTC.
    const before = orderDay(new Date('2026-09-24T21:59:45Z'), 'Europe/Berlin');
    const after = orderDay(new Date('2026-09-24T22:00:02Z'), 'Europe/Berlin');

    expect(before.key).toBe('20260924');
    expect(before.start.toISOString()).toBe('2026-09-23T22:00:00.000Z');
    expect(before.end.toISOString()).toBe('2026-09-24T22:00:00.000Z');

    expect(after.key).toBe('20260925');
    expect(after.start.toISOString()).toBe('2026-09-24T22:00:00.000Z');
    expect(after.end.toISOString()).toBe('2026-09-25T22:00:00.000Z');
  });

  it('handles daylight saving changes (23 and 25 hour days)', () => {
    const spring = orderDay(new Date('2026-03-29T12:00:00Z'), 'Europe/Berlin');
    expect(spring.start.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(spring.end.toISOString()).toBe('2026-03-29T22:00:00.000Z');

    const autumn = orderDay(new Date('2026-10-25T12:00:00Z'), 'Europe/Berlin');
    expect(autumn.start.toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(autumn.end.toISOString()).toBe('2026-10-25T23:00:00.000Z');
  });

  it('does not depend on the server time zone', () => {
    const day = orderDay(new Date('2026-09-24T22:30:00Z'), 'Europe/Berlin');
    // Same result regardless of process.env.TZ, because only Intl with an
    // explicit zone is used.
    expect(day.key).toBe('20260925');
  });
});

describe('resolveOrderTimeZone', () => {
  it('falls back to Europe/Berlin', () => {
    expect(resolveOrderTimeZone(undefined)).toBe(DEFAULT_ORDER_TIME_ZONE);
    expect(resolveOrderTimeZone('')).toBe(DEFAULT_ORDER_TIME_ZONE);
    expect(resolveOrderTimeZone('Mars/Olympus')).toBe(DEFAULT_ORDER_TIME_ZONE);
    expect(resolveOrderTimeZone(42)).toBe(DEFAULT_ORDER_TIME_ZONE);
  });

  it('keeps a valid zone', () => {
    expect(resolveOrderTimeZone('America/New_York')).toBe('America/New_York');
  });
});

describe('formatOrderNumber', () => {
  it('pads the sequence to four digits', () => {
    expect(formatOrderNumber('', '20260924', 1)).toBe('20260924-0001');
    expect(formatOrderNumber('S-', '20260924', 42)).toBe('S-20260924-0042');
    expect(formatOrderNumber('', '20260924', 12345)).toBe('20260924-12345');
  });
});

describe('allocateOrderNumbers', () => {
  let db: FakeDb;
  const allocate = (now: string, extra: { eventId?: string | null } = {}) =>
    allocateOrderNumbers(db.manager(), {
      organizationId: ORG,
      eventId: extra.eventId === undefined ? EVENT : extra.eventId,
      now: new Date(now),
    });

  beforeEach(() => {
    db = new FakeDb();
  });

  it('starts at 0001 on a new local day right after midnight', async () => {
    // The staging case: an order at 23:59:45 Berlin got 20260924-0001; the
    // next one at 00:00:02 must not get the same number again.
    db.add('20260924-0001', '2026-09-24T21:59:45Z');

    await expect(allocate('2026-09-24T22:00:02Z')).resolves.toEqual({
      orderNumber: '20260925-0001',
      dailyNumber: 1,
    });
  });

  it('continues the sequence until local midnight', async () => {
    db.add('20260924-0001', '2026-09-24T08:00:00Z');
    db.add('20260924-0002', '2026-09-24T21:59:00Z', { dailyNumber: 2 });

    await expect(allocate('2026-09-24T21:59:59Z')).resolves.toEqual({
      orderNumber: '20260924-0003',
      dailyNumber: 3,
    });
  });

  it('continues after numbers that older code gave the same date', async () => {
    // Before the fix the date came from UTC: orders between 00:00 and 02:00
    // Berlin on 25.09. carry 20260924-…; they still block those numbers.
    db.add('20260924-0007', '2026-09-24T22:30:00Z');

    const result = await allocate('2026-09-24T21:00:00Z');
    expect(result.orderNumber).toBe('20260924-0008');
  });

  it('uses the highest number, not the count (gaps after deletes)', async () => {
    db.add('20260924-0001', '2026-09-24T08:00:00Z');
    db.add('20260924-0003', '2026-09-24T09:00:00Z', { dailyNumber: 3 });

    await expect(allocate('2026-09-24T10:00:00Z')).resolves.toEqual({
      orderNumber: '20260924-0004',
      dailyNumber: 4,
    });
  });

  it('keeps shop numbers (S-) and register numbers apart', async () => {
    db.add('S-20260924-0001', '2026-09-24T08:00:00Z');

    const register = await allocate('2026-09-24T10:00:00Z');
    expect(register.orderNumber).toBe('20260924-0001');

    const shop = await allocateOrderNumbers(db.manager(), {
      organizationId: ORG,
      eventId: EVENT,
      prefix: 'S-',
      now: new Date('2026-09-24T10:00:00Z'),
    });
    expect(shop.orderNumber).toBe('S-20260924-0002');
  });

  it('ignores other organisations', async () => {
    db.add('20260924-0009', '2026-09-24T08:00:00Z', {
      organizationId: OTHER_ORG,
      dailyNumber: 9,
    });

    await expect(allocate('2026-09-24T10:00:00Z')).resolves.toEqual({
      orderNumber: '20260924-0001',
      dailyNumber: 1,
    });
  });

  it('counts the daily number per event, or per organisation without one', async () => {
    db.add('20260924-0001', '2026-09-24T08:00:00Z', {
      eventId: OTHER_EVENT,
      dailyNumber: 5,
    });

    expect((await allocate('2026-09-24T10:00:00Z')).dailyNumber).toBe(1);
    expect(
      (await allocate('2026-09-24T10:00:00Z', { eventId: null })).dailyNumber,
    ).toBe(6);
  });

  it("uses the organisation's time zone", async () => {
    db.timeZones.set(ORG, 'America/New_York');

    // 03:00 UTC on 25.09. is still 24.09. in New York.
    const result = await allocate('2026-09-25T03:00:00Z');
    expect(result.orderNumber).toBe('20260924-0001');
  });
});

describe('saveOrderWithNumbers', () => {
  it('takes the per-organisation lock before allocating', async () => {
    const db = new FakeDb();
    const order = await saveOrderWithNumbers(
      db.repository(),
      {
        organizationId: ORG,
        eventId: EVENT,
        now: new Date('2026-09-24T10:00:00Z'),
      },
      { tableNumber: '4', createdAt: new Date('2026-09-24T10:00:00Z') },
    );

    expect(db.lockCalls).toEqual([[ORDER_NUMBER_LOCK_NAMESPACE, ORG]]);
    expect(order).toMatchObject({
      organizationId: ORG,
      eventId: EVENT,
      orderNumber: '20260924-0001',
      dailyNumber: 1,
      tableNumber: '4',
    });
  });

  it('gives concurrent orders distinct numbers', async () => {
    const db = new FakeDb();
    const now = new Date('2026-09-24T22:00:02Z');
    const orders = await Promise.all(
      [1, 2, 3].map(() =>
        saveOrderWithNumbers(
          db.repository(),
          { organizationId: ORG, eventId: EVENT, now },
          { createdAt: now },
        ),
      ),
    );

    expect(orders.map((o) => o.orderNumber).sort()).toEqual([
      '20260925-0001',
      '20260925-0002',
      '20260925-0003',
    ]);
    expect(orders.map((o) => o.dailyNumber).sort()).toEqual([1, 2, 3]);
  });
});
