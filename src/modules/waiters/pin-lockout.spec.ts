import { HttpException } from '@nestjs/common';
import { ErrorReasons } from '../../common/constants/error-codes';
import {
  PinLockoutService,
  lockFor,
  remainingAttempts,
} from './pin-lockout.service';

/** Redis-Ersatz mit incr/expire/ttl/set/del (Sekunden, eigene Uhr). */
function fakeRedis() {
  const values = new Map<string, { value: number; ttl: number | null }>();
  const state = { broken: false };
  return {
    values,
    get broken() {
      return state.broken;
    },
    set broken(value: boolean) {
      state.broken = value;
    },
    incr(key: string) {
      if (state.broken) return Promise.reject(new Error('down'));
      const entry = values.get(key) ?? { value: 0, ttl: null };
      entry.value += 1;
      values.set(key, entry);
      return Promise.resolve(entry.value);
    },
    expire(key: string, ttl: number) {
      const entry = values.get(key);
      if (entry) entry.ttl = ttl;
      return Promise.resolve(1);
    },
    ttl(key: string) {
      if (state.broken) return Promise.reject(new Error('down'));
      const entry = values.get(key);
      return Promise.resolve(entry ? (entry.ttl ?? -1) : -2);
    },
    set(key: string, _v: string, opts: { EX: number }) {
      if (state.broken) return Promise.reject(new Error('down'));
      values.set(key, { value: 1, ttl: opts.EX });
      return Promise.resolve('OK');
    },
    del(key: string) {
      values.delete(key);
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
  const device = {
    id: 'dev-1',
    organizationId: 'org-1',
    name: 'Kasse 1',
    settings: {},
  };
  return { redis, queries, service, device };
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

describe('PIN lockout (5 → 30 s, 10 → 5 min, 20 → admin)', () => {
  it('computes the steps', () => {
    expect([1, 4, 5, 9, 10, 19, 20, 25].map(lockFor)).toEqual([
      undefined,
      undefined,
      30,
      30,
      300,
      300,
      null,
      null,
    ]);
    expect([0, 4, 5, 9, 10, 19, 20].map(remainingAttempts)).toEqual([
      5, 1, 5, 1, 10, 1, 0,
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

  it('a hit resets the counter', async () => {
    const { service, device, redis } = setup();
    for (let i = 0; i < 4; i += 1) await service.recordFailure(device);
    await service.recordSuccess(device);
    expect(redis.values.has('waiter-pin:fail:dev-1')).toBe(false);
    expect((await service.recordFailure(device)).remainingAttempts).toBe(4);
  });

  it('locks 5 minutes after ten and until an admin releases after twenty', async () => {
    const { service, device, queries, redis } = setup();
    for (let i = 0; i < 10; i += 1) await service.recordFailure(device);
    expect(redis.values.get('waiter-pin:lock:dev-1')?.ttl).toBe(300);
    for (let i = 0; i < 10; i += 1) await service.recordFailure(device);
    const sql = queries.map(([q]) => q).join('\n');
    expect(sql).toContain('waiterPinLockedAt');
    expect(sql).toContain("end_reason = 'device_blocked'");
    expect(sql).toContain('waiter_pin_lock');
    // Zaehler zurueck, die Sperre steht in der Datenbank.
    expect(redis.values.has('waiter-pin:fail:dev-1')).toBe(false);
    expect(
      await lockReason(
        service.assertNotLocked({
          ...device,
          settings: { waiterPinLockedAt: new Date().toISOString() },
        }),
      ),
    ).toMatchObject({ status: 429, reason: ErrorReasons.PIN_DEVICE_LOCKED });
  });

  it('pauses PIN entry of the whole organization after more than 50 failures in 10 min', async () => {
    const { service, redis } = setup();
    for (let i = 0; i < 51; i += 1) {
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
  });

  it('keeps counting in memory while Redis is down', async () => {
    const { service, device, redis } = setup();
    redis.broken = true;
    for (let i = 0; i < 5; i += 1) await service.recordFailure(device);
    const locked = await lockReason(service.assertNotLocked(device));
    expect(locked).toMatchObject({ reason: ErrorReasons.PIN_LOCKED });
  });
});
