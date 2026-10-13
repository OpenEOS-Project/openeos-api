import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { Response } from 'express';
import { Public } from '../../common/decorators';
import { ShutdownService } from '../../common/lifecycle/shutdown.service';
import { REDIS_CLIENT } from '../../common/redis';
import type { RedisClient } from '../../common/redis';

type CheckResult = {
  status: 'ok' | 'error';
  message?: string;
  latency?: number;
};

interface HealthCheck {
  status: 'ok' | 'error';
  timestamp: string;
  uptime: number;
  version: string;
  checks?: Record<string, CheckResult>;
}

// Injected by the GitHub Action as build number (e.g. "1.0.123"); falls back
// to the package version for local/dev runs.
const APP_VERSION =
  process.env.APP_VERSION || process.env.npm_package_version || 'dev';

/** A readiness check that takes longer than this counts as failed. */
const CHECK_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`${what} did not answer within ${CHECK_TIMEOUT_MS} ms`),
        ),
      CHECK_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function timed(
  what: string,
  check: () => Promise<void>,
): Promise<CheckResult> {
  const start = Date.now();
  try {
    await withTimeout(check(), what);
    return { status: 'ok', latency: Date.now() - start };
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : `${what} failed`,
    };
  }
}

@ApiTags('Health')
@Controller('health')
export class HealthController {
  /** Set once all migrations are applied; they do not un-apply. */
  private migrationsApplied = false;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject(REDIS_CLIENT)
    private readonly redis: RedisClient,
    private readonly shutdown: ShutdownService,
  ) {}

  @Public()
  @Get()
  check(): HealthCheck {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: APP_VERSION,
    };
  }

  /**
   * Readiness: may this instance get traffic? 503 unless the database and
   * Redis answer, the schema is up to date and the instance is not shutting
   * down. Container health checks use this, so a new instance only joins
   * the load balancer when it can actually serve.
   */
  @Public()
  @Get('ready')
  async readiness(
    @Res({ passthrough: true }) res?: Response,
  ): Promise<HealthCheck> {
    const result = await this.runChecks();
    if (result.status === 'error') res?.status(503);
    return result;
  }

  @Public()
  @Get('live')
  liveness(): HealthCheck {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: APP_VERSION,
    };
  }

  @Public()
  @Get('detailed')
  async detailed(): Promise<
    HealthCheck & { memory: NodeJS.MemoryUsage; version: string }
  > {
    const readinessCheck = await this.runChecks();

    return {
      ...readinessCheck,
      memory: process.memoryUsage(),
    };
  }

  private async runChecks(): Promise<HealthCheck> {
    const [database, redis, migrations] = await Promise.all([
      timed('Database', async () => {
        await this.dataSource.query('SELECT 1');
      }),
      timed('Redis', async () => {
        await this.redis.ping();
      }),
      timed('Migrations', async () => {
        if (this.migrationsApplied) return;
        // Mit DATABASE_MIGRATIONS_RUN=false laufen die Migrationen als
        // eigener Schritt vor dem Rollout. Fehlen sie, soll die neue
        // Instanz keinen Verkehr bekommen — der Rollout bricht dann ab und
        // die alten Instanzen laufen weiter.
        if (await this.dataSource.showMigrations()) {
          throw new Error('Pending database migrations');
        }
        this.migrationsApplied = true;
      }),
    ]);

    const checks: Record<string, CheckResult> = { database, redis, migrations };
    if (this.shutdown.isDraining) {
      checks.shutdown = { status: 'error', message: 'Shutting down' };
    }

    const hasErrors = Object.values(checks).some((c) => c.status === 'error');

    return {
      status: hasErrors ? 'error' : 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: APP_VERSION,
      checks,
    };
  }
}
