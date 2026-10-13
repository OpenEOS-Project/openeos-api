import type { createClient } from 'redis';

/** Injection token for the shared Redis client (see RedisModule). */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

export type RedisClient = ReturnType<typeof createClient>;

/** Redis URL from host, port and the optional REDIS_PASSWORD. */
export function redisUrl(host: string, port: number, password?: string) {
  return password
    ? `redis://:${encodeURIComponent(password)}@${host}:${port}`
    : `redis://${host}:${port}`;
}
