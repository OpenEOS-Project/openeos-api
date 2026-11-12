import { createClient } from 'redis';

import { RedisThrottlerStorage } from './redis-throttler.storage';
import type { RedisClient } from './redis.constants';

/**
 * Gegen ein echtes Redis nur mit TEST_REDIS_URL, z. B.
 *
 *   TEST_REDIS_URL=redis://127.0.0.1:6379 pnpm test redis-throttler
 */
const TEST_REDIS = process.env.TEST_REDIS_URL;
const describeWithRedis = TEST_REDIS ? describe : describe.skip;

describeWithRedis('RedisThrottlerStorage against Redis', () => {
  let client: RedisClient;
  const run = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    client = createClient({ url: TEST_REDIS });
    await client.connect();
  });
  afterAll(async () => {
    const keys = await client.keys(`openeos:throttle:*${run}*`);
    if (keys.length) await client.del(keys);
    await client.quit();
  });

  it('shares the count between instances', async () => {
    const a = new RedisThrottlerStorage(client);
    const b = new RedisThrottlerStorage(client);
    const key = `shared-${run}`;

    expect(
      (await a.increment(key, 60_000, 2, 60_000, 'default')).totalHits,
    ).toBe(1);
    expect(
      (await b.increment(key, 60_000, 2, 60_000, 'default')).isBlocked,
    ).toBe(false);
    const third = await a.increment(key, 60_000, 2, 60_000, 'default');
    expect(third).toMatchObject({ totalHits: 3, isBlocked: true });
    expect(third.timeToBlockExpire).toBeGreaterThan(55);

    const fourth = await b.increment(key, 60_000, 2, 60_000, 'default');
    expect(fourth.isBlocked).toBe(true);
  });

  it('starts a new window after the ttl', async () => {
    const storage = new RedisThrottlerStorage(client);
    const key = `window-${run}`;
    await storage.increment(key, 100, 1, 100, 'default');
    expect(
      (await storage.increment(key, 100, 1, 100, 'default')).isBlocked,
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(
      (await storage.increment(key, 100, 1, 100, 'default')).isBlocked,
    ).toBe(false);
  });
});

describe('RedisThrottlerStorage', () => {
  it('maps the script reply to seconds', async () => {
    const redis = { eval: jest.fn().mockResolvedValue([4, 30_500, 1, 59_001]) };
    const storage = new RedisThrottlerStorage(redis as never);

    await expect(
      storage.increment('k', 60_000, 3, 60_000, 'default'),
    ).resolves.toEqual({
      totalHits: 4,
      timeToExpire: 31,
      isBlocked: true,
      timeToBlockExpire: 60,
    });
    expect(redis.eval).toHaveBeenCalledWith(expect.any(String), {
      keys: [
        'openeos:throttle:default:k:hits',
        'openeos:throttle:default:k:block',
      ],
      arguments: ['60000', '3', '60000'],
    });
  });

  it('keeps counting in memory while Redis is unavailable', async () => {
    const redis = {
      eval: jest.fn().mockRejectedValue(new Error('The client is closed')),
    };
    const storage = new RedisThrottlerStorage(redis as never);

    const first = await storage.increment('k', 60_000, 1, 60_000, 'default');
    const second = await storage.increment('k', 60_000, 1, 60_000, 'default');
    storage.onApplicationShutdown();

    expect(first.isBlocked).toBe(false);
    expect(second.isBlocked).toBe(true);
  });
});
