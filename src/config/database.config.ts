import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

/**
 * Defaults for the connection pool (node-postgres).
 *
 * - max 10: the API already held at most this many connections before
 *   (`poolSize: 10`), so the load profile does not change. The database
 *   allows 100 (Postgres default `max_connections`); even if production
 *   and staging shared one instance, 80 would remain free for
 *   migrations, psql and maintenance.
 * - idle 10 min: idle connections are kept instead of being closed after
 *   the 10 s pg default and re-opened on the next call at roughly 70 ms
 *   each.
 * - connect 5 s: previously there was no limit. With an exhausted pool
 *   or an unreachable database, a request waited indefinitely. Now it
 *   fails after 5 s, which is still enough to queue through short load
 *   spikes.
 *
 * Every value can be overridden via ENV (see `.env.example`).
 */
export const POOL_DEFAULTS = {
  max: 10,
  idleTimeoutMillis: 10 * 60 * 1000,
  connectionTimeoutMillis: 5000,
} as const;

export interface PoolOptions {
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Pool options from the environment; invalid or missing values fall back to the defaults. */
export function poolOptions(env: NodeJS.ProcessEnv = process.env): PoolOptions {
  return {
    max: positiveInteger(env.DATABASE_POOL_MAX, POOL_DEFAULTS.max),
    idleTimeoutMillis: positiveInteger(
      env.DATABASE_POOL_IDLE_TIMEOUT_MS,
      POOL_DEFAULTS.idleTimeoutMillis,
    ),
    connectionTimeoutMillis: positiveInteger(
      env.DATABASE_POOL_CONNECTION_TIMEOUT_MS,
      POOL_DEFAULTS.connectionTimeoutMillis,
    ),
  };
}

export default registerAs(
  'database',
  (): TypeOrmModuleOptions => ({
    type: 'postgres',
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    username: process.env.DATABASE_USER || 'openeos',
    password: process.env.DATABASE_PASSWORD || 'openeos_dev_password',
    database: process.env.DATABASE_NAME || 'openeos',
    entities: [__dirname + '/../database/entities/*.entity{.ts,.js}'],
    migrations: [__dirname + '/../database/migrations/*{.ts,.js}'],
    synchronize: process.env.DATABASE_SYNCHRONIZE === 'true',
    logging: process.env.DATABASE_LOGGING === 'true',
    migrationsRun: process.env.DATABASE_MIGRATIONS_RUN === 'true',
    /* Passed unchanged to the pg pool. `max` lives only here, not also as
       TypeORM `poolSize` — `extra` would win anyway. */
    extra: poolOptions(),
  }),
);
