import { HttpException } from '@nestjs/common';
import { ErrorReasons } from '../../common/constants/error-codes';
import {
  PinLockoutService,
  lockFor,
  orgLockFor,
  remainingAttempts,
} from './pin-lockout.service';

/** Redis-Ersatz mit Sorted Sets, MULTI und Ablauf (Sekunden, eigene Uhr). */
function fakeRedis() {
  const values = new Map<string, { value: number; ttl: number | null }>();
  const sets = new Map<string, Map<string, number>>();
  const state = { broken: false };
  const assertUp = () => {
    if (state.broken) throw new Error('down');
  };
  return {
    values,
    sets,
    get broken() {
      return state.broken;
    },
    set broken(value: boolean) {
      state.broken = value;
    },
    /** Nur das Fenster-Skript des Dienstes. */
    eval(
      _script: string,
      opts: { keys: string[]; arguments: string[] },
    ): Promise<number> {
      if (state.broken) return Promise.reject(new Error('down'));
      const [key] = opts.keys;
      const [since, now, member] = opts.arguments;
      const set = sets.get(key) ?? new Map<string, number>();
      for (const [m, score] of set) {
        if (score <= Number(since)) set.delete(m);
      }
      set.set(member, Number(now));
      sets.set(key, set);
      return Promise.resolve(set.size);
    },
    ttl(key: string) {
      if (state.broken) return Promise.reject(new Error('down'));
      const entry = values.get(key);
      return Promise.resolve(entry ? (entry.ttl ?? -1) : -2);
    },
    set(key: string, _v: string, opts: { EX: number }) {
      assertUp();
      values.set(key, { value: 1, ttl: opts.EX });
      return Promise.resolve('OK');
    },
    del(key: string) {
      values.delete(key);
      sets.delete(key);
      return Promise.resolve(1);
    },
  };
}

function setup() {
  const redis = fakeRedis();
  const queries: Array<[string, unknown[]]> = [];
  const dataSource = {
    query: jest.fn((sql: string, params: unknown[]) => {
      queries.push([sql, params]);
      return Promise.resolve([]);
    }),
  };
  const service = new PinLockoutService(redis as never, dataSource as never);
  const clock = { now: Date.parse('2031-06-01T18:00:00Z') };
  service.now = () => clock.now;
  const device = {
    id: 'dev-1',
    organizationId: 'org-1',
    name: 'Kasse 1',
    settings: {},
  };
  /** Sperren laufen in der Ersatz-Redis nicht selbst ab. */
  const expireLocks = () => {
    for (const key of [...redis.values.keys()]) {
      if (key.includes(':lock:') || key.includes(':orglock:')) {
        redis.values.delete(key);
      }
    }
  };
  return { redis, queries, service, device, clock, expireLocks };
}

async function lockReason(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const response = (error as HttpException).getResponse() as {
      reason: string;
      params?: { retryAfterSeconds?: number };
    };
    return { status: (error as HttpException).getStatus(), ...response };
  }
  return null;
}

describe('PIN attempt limits', () => {
  it('doubles the waiting time per failure and caps it', () => {
    expect([1, 4, 5, 6, 7, 8, 9, 10, 19, 20, 25].map(lockFor)).toEqual([
      undefined,
      undefined,
      30,
      60,
      120,
      240,
      480,
      900,
      900,
      null,
      null,
    ]);
    expect([0, 4, 5, 9].map(remainingAttempts)).toEqual([5, 1, 0, 0]);
    expect([50, 51, 52, 53, 70].map(orgLockFor)).toEqual([
      undefined,
      60,
      120,
      240,
      900,
    ]);
  });

  it('locks the device for 30 s after five wrong PINs', async () => {
    const { service, device } = setup();
    for (let i = 1; i <= 4; i += 1) {
      const outcome = await service.recordFailure(device);
      expect(outcome.remainingAttempts).toBe(5 - i);
      await expect(service.assertNotLocked(device)).resolves.toBeUndefined();
    }
    const fifth = await service.recordFailure(device);
    expect(fifth.lockedForSeconds).toBe(30);
    expect(await lockReason(service.assertNotLocked(device))).toMatchObject({
      status: 429,
      reason: ErrorReasons.PIN_LOCKED,
      params: { retryAfterSeconds: 30 },
    });
  });

  it('accepts PIN entry again once the waiting time is over', async () => {
    const { service, device, expireLocks } = setup();
    for (let i = 0; i < 5; i += 1) await service.recordFailure(device);
    await expect(service.assertNotLocked(device)).rejects.toBeInstanceOf(
      HttpException,
    );
    expireLocks();
    await expect(service.assertNotLocked(device)).resolves.toBeUndefined();
  });

  it('forgets failures that are older than the window', async () => {
    const { service, device, clock, expireLocks } = setup();
    for (let i = 0; i < 4; i += 1) await service.recordFailure(device);
    clock.now += 31 * 60 * 1000;
    expireLocks();
    const outcome = await service.recordFailure(device);
    expect(outcome.failures).toBe(1);
    expect(outcome.lockedForSeconds).toBeUndefined();
  });

  it('a shorter lock does not shorten a running longer one', async () => {
    const { service, device, redis } = setup();
    redis.values.set('waiter-pin:lock:dev-1', { value: 1, ttl: 600 });
    for (let i = 0; i < 5; i += 1) await service.recordFailure(device);
    expect(redis.values.get('waiter-pin:lock:dev-1')?.ttl).toBe(600);
  });

  it('locks until an admin releases after twenty failures in the window', async () => {
    const { service, device, queries, redis, expireLocks } = setup();
    for (let i = 0; i < 19; i += 1) {
      await service.recordFailure(device);
      expireLocks();
    }
    expect(queries).toHaveLength(0);
    const twentieth = await service.recordFailure(device);
    expect(twentieth.lockedForSeconds).toBeNull();
    const sql = queries.map(([q]) => q).join('\n');
    expect(sql).toContain('waiterPinLockedAt');
    expect(sql).toContain("end_reason = 'device_blocked'");
    expect(sql).toContain('waiter_pin_lock');
    // Zaehler zurueck, die Sperre steht in der Datenbank.
    expect(redis.sets.has('waiter-pin:fails:dev-1')).toBe(false);
    expect(
      await lockReason(
        service.assertNotLocked({
          ...device,
          settings: { waiterPinLockedAt: new Date().toISOString() },
        }),
      ),
    ).toMatchObject({ status: 429, reason: ErrorReasons.PIN_DEVICE_LOCKED });
  });

  it('an admin release also clears a running timed lock', async () => {
    const { service, device } = setup();
    for (let i = 0; i < 6; i += 1) await service.recordFailure(device);
    await service.releaseDevice(device.id);
    await expect(service.assertNotLocked(device)).resolves.toBeUndefined();
    expect((await service.recordFailure(device)).failures).toBe(1);
  });

  it('pauses PIN entry of the whole organization after more than 50 failures in an hour', async () => {
    const { service, redis, clock } = setup();
    for (let i = 0; i < 51; i += 1) {
      // Verteilt ueber Geraete und fast eine Stunde.
      clock.now += 60 * 1000;
      await service.recordFailure({
        id: `dev-${i}`,
        organizationId: 'org-1',
        name: 'x',
      });
    }
    expect(redis.values.get('waiter-pin:orglock:org-1')?.ttl).toBe(60);
    expect(
      await lockReason(
        service.assertNotLocked({
          id: 'dev-new',
          organizationId: 'org-1',
          settings: {},
        }),
      ),
    ).toMatchObject({
      reason: ErrorReasons.PIN_LOCKED,
      params: { retryAfterSeconds: 60 },
    });
    redis.values.delete('waiter-pin:orglock:org-1');
    await service.recordFailure({
      id: 'dev-other',
      organizationId: 'org-1',
      name: 'x',
    });
    expect(redis.values.get('waiter-pin:orglock:org-1')?.ttl).toBe(120);
  });

  it('keeps counting in memory while Redis is down', async () => {
    const { service, device, redis } = setup();
    redis.broken = true;
    for (let i = 0; i < 5; i += 1) await service.recordFailure(device);
    const locked = await lockReason(service.assertNotLocked(device));
    expect(locked).toMatchObject({ reason: ErrorReasons.PIN_LOCKED });
  });
});

/**
 * Das Fenster-Skript gegen ein echtes Redis, z. B.
 *
 *   TEST_REDIS_URL=redis://127.0.0.1:6379/15 pnpm test pin-lockout
 */
const TEST_REDIS = process.env.TEST_REDIS_URL;
(TEST_REDIS ? describe : describe.skip)('PIN attempt limits with Redis', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createClient } = require('redis') as typeof import('redis');
  const client = createClient({ url: TEST_REDIS });
  const prefix = `t-${Date.now()}`;

  beforeAll(() => client.connect());
  afterAll(async () => {
    for (const key of await client.keys('waiter-pin:*')) {
      if (key.includes(prefix)) await client.del(key);
    }
    await client.quit();
  });

  it('counts failures in a sliding window and sets increasing locks', async () => {
    const service = new PinLockoutService(
      client as never,
      {
        query: () => Promise.resolve([]),
      } as never,
    );
    let now = Date.parse('2031-06-01T18:00:00Z');
    service.now = () => now;
    const device = {
      id: `${prefix}-dev`,
      organizationId: `${prefix}-org`,
      name: 'x',
    };
    const outcomes = [];
    for (let i = 0; i < 6; i += 1)
      outcomes.push(await service.recordFailure(device));
    expect(outcomes.map((o) => o.failures)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(outcomes[5].lockedForSeconds).toBe(60);
    expect(await client.ttl(`waiter-pin:lock:${device.id}`)).toBeGreaterThan(
      30,
    );
    now += 31 * 60 * 1000;
    expect((await service.recordFailure(device)).failures).toBe(1);
  });
});
