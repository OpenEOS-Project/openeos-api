import { CronLockService } from './cron-lock.service';

/** Minimal stand-in for Redis `SET key value NX PX ttl`. */
function fakeRedis() {
  const store = new Map<string, string>();
  const set = jest.fn(
    (
      key: string,
      value: string,
      options?: { condition?: string; expiration?: { value: number } },
    ) => {
      // Ein Tick Verzoegerung, damit sich parallele Aufrufe ueberlappen.
      return new Promise<string | null>((resolve) =>
        setImmediate(() => {
          if (options?.condition === 'NX' && store.has(key)) {
            return resolve(null);
          }
          store.set(key, value);
          resolve('OK');
        }),
      );
    },
  );
  return { store, set };
}

describe('CronLockService', () => {
  const dueAt = new Date('2026-10-14T06:00:00.120Z');

  it('runs a job once although every instance fires it', async () => {
    const redis = fakeRedis();
    const instances = [1, 2, 3].map(() => new CronLockService(redis as never));
    const job = jest.fn(() => Promise.resolve());

    const ran = await Promise.all(
      instances.map((lock) => lock.runExclusive('reminders', job, dueAt)),
    );

    expect(job).toHaveBeenCalledTimes(1);
    expect(ran.filter(Boolean)).toHaveLength(1);
    expect([...redis.store.keys()]).toEqual([
      'openeos:cron:reminders:2026-10-14T06:00',
    ]);
  });

  it('claims with SET NX and an expiry', async () => {
    const redis = fakeRedis();
    await new CronLockService(redis as never).runExclusive(
      'reminders',
      () => Promise.resolve(),
      dueAt,
    );

    expect(redis.set).toHaveBeenCalledWith(
      'openeos:cron:reminders:2026-10-14T06:00',
      expect.any(String),
      { condition: 'NX', expiration: { type: 'PX', value: 600_000 } },
    );
  });

  it('keeps the slot after a quick run, so a late instance skips', async () => {
    const redis = fakeRedis();
    const job = jest.fn(() => Promise.resolve());

    await new CronLockService(redis as never).runExclusive('j', job, dueAt);
    const late = new Date(dueAt.getTime() + 500);
    await new CronLockService(redis as never).runExclusive('j', job, late);

    expect(job).toHaveBeenCalledTimes(1);
  });

  it('runs again at the next due time', async () => {
    const redis = fakeRedis();
    const job = jest.fn(() => Promise.resolve());
    const lock = new CronLockService(redis as never);

    await lock.runExclusive('j', job, dueAt);
    await lock.runExclusive('j', job, new Date('2026-10-14T07:00:00.050Z'));

    expect(job).toHaveBeenCalledTimes(2);
  });

  it('keeps different jobs apart', async () => {
    const redis = fakeRedis();
    const a = jest.fn(() => Promise.resolve());
    const b = jest.fn(() => Promise.resolve());
    const lock = new CronLockService(redis as never);

    await lock.runExclusive('a', a, dueAt);
    await lock.runExclusive('b', b, dueAt);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('skips the run when Redis can not be asked', async () => {
    const redis = {
      set: jest.fn(() => Promise.reject(new Error('The client is closed'))),
    };
    const job = jest.fn(() => Promise.resolve());

    const ran = await new CronLockService(redis as never).runExclusive(
      'j',
      job,
      dueAt,
    );

    expect(ran).toBe(false);
    expect(job).not.toHaveBeenCalled();
  });
});
