import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ThrottlerModuleOptions,
  ThrottlerStorage,
  ThrottlerStorageRecord,
} from '@nestjs/throttler';

import {
  API_TOKEN_LIMITS,
  ApiTokenThrottlerGuard,
} from './api-token-throttler.guard';

/* Ein Zaehler je Schluessel, wie der Speicher des Throttler-Moduls. */
function fakeStorage() {
  const hits = new Map<string, number>();
  const storage: ThrottlerStorage = {
    increment: (key, ttl, limit): Promise<ThrottlerStorageRecord> => {
      const total = (hits.get(key) ?? 0) + 1;
      hits.set(key, total);
      return Promise.resolve({
        totalHits: total,
        timeToExpire: Math.ceil(ttl / 1000),
        isBlocked: total > limit,
        timeToBlockExpire: total > limit ? Math.ceil(ttl / 1000) : 0,
      });
    },
  };
  return { storage, hits };
}

function contextFor(apiToken?: { id: string }): {
  context: ExecutionContext;
  headers: Record<string, unknown>;
} {
  const headers: Record<string, unknown> = {};
  const req = { ip: '203.0.113.7', headers: {}, apiToken };
  const res = {
    header: (name: string, value: unknown) => {
      headers[name] = value;
    },
  };
  const context = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
  return { context, headers };
}

async function guardWith(storage: ThrottlerStorage) {
  const options: ThrottlerModuleOptions = { throttlers: [] };
  const guard = new ApiTokenThrottlerGuard(options, storage, new Reflector());
  // Nest ruft das im Betrieb; hier von Hand, damit commonOptions gesetzt ist.
  await guard.onModuleInit();
  return guard;
}

describe('ApiTokenThrottlerGuard', () => {
  it('declares 120 per minute and 5000 per day', () => {
    expect(API_TOKEN_LIMITS.map((l) => [l.limit, l.ttl])).toEqual([
      [120, 60_000],
      [5000, 86_400_000],
    ]);
  });

  it('ignores requests without an API token', async () => {
    const { storage, hits } = fakeStorage();
    const guard = await guardWith(storage);
    expect(await guard.canActivate(contextFor().context)).toBe(true);
    expect(hits.size).toBe(0);
  });

  it('counts per token, not per address', async () => {
    const { storage, hits } = fakeStorage();
    const guard = await guardWith(storage);
    const a = contextFor({ id: 'token-a' });
    const b = contextFor({ id: 'token-b' });

    expect(await guard.canActivate(a.context)).toBe(true);
    expect(await guard.canActivate(a.context)).toBe(true);
    expect(await guard.canActivate(b.context)).toBe(true);

    expect(hits.get('api-token-minute:api-token:token-a')).toBe(2);
    expect(hits.get('api-token-day:api-token:token-a')).toBe(2);
    expect(hits.get('api-token-minute:api-token:token-b')).toBe(1);
    expect(a.headers['X-RateLimit-Limit-api-token-minute']).toBe(120);
    expect(a.headers['X-RateLimit-Remaining-api-token-minute']).toBe(118);
    expect(a.headers['X-RateLimit-Limit-api-token-day']).toBe(5000);
  });

  it('answers 429 API_TOKEN_RATE_LIMITED once the minute is used up', async () => {
    const { storage } = fakeStorage();
    const guard = await guardWith(storage);
    const { context, headers } = contextFor({ id: 'token-a' });

    for (let i = 0; i < 120; i++) {
      expect(await guard.canActivate(context)).toBe(true);
    }
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      constructor: HttpException,
      response: {
        code: 'RATE_LIMITED',
        reason: 'API_TOKEN_RATE_LIMITED',
        params: { limit: 120, window: 'minute', retryAfterSeconds: 60 },
      },
    });
    expect(headers['Retry-After-api-token-minute']).toBe(60);
  });

  it('answers with the day window once that is used up', async () => {
    const { storage } = fakeStorage();
    const guard = await guardWith(storage);
    const { context } = contextFor({ id: 'token-a' });
    // Minute counter stays fresh; only the day counter fills up.
    const dayKey = 'api-token-day:api-token:token-a';
    const spy = jest.spyOn(storage, 'increment');
    spy.mockImplementation((key, ttl, limit) =>
      Promise.resolve({
        totalHits: key === dayKey ? limit + 1 : 1,
        timeToExpire: Math.ceil(ttl / 1000),
        isBlocked: key === dayKey,
        timeToBlockExpire: key === dayKey ? 3600 : 0,
      }),
    );
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: {
        params: { limit: 5000, window: 'day', retryAfterSeconds: 3600 },
      },
    });
  });
});
