import { Logger } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';

import type { RedisClient } from './redis.constants';

/** Rueckgabe von ThrottlerStorage.increment (Zeiten in Sekunden). */
export interface ThrottleRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

type EvalClient = Pick<RedisClient, 'eval'>;

const KEY_PREFIX = 'openeos:throttle:';

/**
 * Zaehlt atomar in einem festen Fenster und sperrt nach Ueberschreiten fuer
 * `blockDuration`. Rueckgabe: Treffer, Restlaufzeit des Fensters (ms),
 * gesperrt (0/1), Restlaufzeit der Sperre (ms).
 */
const INCREMENT_SCRIPT = `
local hitsKey = KEYS[1]
local blockKey = KEYS[2]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDuration = tonumber(ARGV[3])
local blockTtl = redis.call('PTTL', blockKey)
if blockTtl > 0 then
  local hits = tonumber(redis.call('GET', hitsKey) or '0')
  local hitsTtl = redis.call('PTTL', hitsKey)
  if hitsTtl < 0 then hitsTtl = 0 end
  return {hits, hitsTtl, 1, blockTtl}
end
local hits = redis.call('INCR', hitsKey)
local hitsTtl = redis.call('PTTL', hitsKey)
if hitsTtl < 0 then
  redis.call('PEXPIRE', hitsKey, ttl)
  hitsTtl = ttl
end
if hits > limit then
  if blockDuration > 0 then
    redis.call('SET', blockKey, '1', 'PX', blockDuration)
    return {hits, hitsTtl, 1, blockDuration}
  end
  return {hits, hitsTtl, 1, hitsTtl}
end
return {hits, hitsTtl, 0, 0}
`;

const seconds = (ms: number) => Math.max(0, Math.ceil(ms / 1000));

/**
 * Speicher des Rate-Limits in Redis, damit die Grenzen ueber alle
 * API-Instanzen gemeinsam gelten. Ist Redis gerade nicht erreichbar, zaehlt
 * die Instanz voruebergehend im eigenen Speicher weiter, statt Anfragen
 * abzuweisen oder ganz ohne Grenze durchzulassen.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger('ThrottlerStorage');
  private readonly fallback = new ThrottlerStorageService();
  private lastWarning = 0;

  constructor(private readonly redis: EvalClient) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottleRecord> {
    const base = `${KEY_PREFIX}${throttlerName}:${key}`;
    try {
      const reply = (await this.redis.eval(INCREMENT_SCRIPT, {
        keys: [`${base}:hits`, `${base}:block`],
        arguments: [
          String(Math.max(1, Math.round(ttl))),
          String(limit),
          String(Math.max(0, Math.round(blockDuration))),
        ],
      })) as unknown as [number, number, number, number];
      const [hits, hitsTtl, blocked, blockTtl] = reply.map(Number);
      return {
        totalHits: hits,
        timeToExpire: seconds(hitsTtl),
        isBlocked: blocked === 1,
        timeToBlockExpire: seconds(blockTtl),
      };
    } catch (error) {
      this.warn(error);
      return this.fallback.increment(
        key,
        ttl,
        limit,
        blockDuration,
        throttlerName,
      );
    }
  }

  onApplicationShutdown(): void {
    this.fallback.onApplicationShutdown();
  }

  private warn(error: unknown): void {
    const now = Date.now();
    if (now - this.lastWarning < 60_000) return;
    this.lastWarning = now;
    this.logger.warn(
      `Rate limit counted locally, Redis not available: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
