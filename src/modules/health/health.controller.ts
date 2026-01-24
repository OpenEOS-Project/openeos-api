import {
  Controller,
  Get,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { Inject } from '@nestjs/common';
import { Public } from '../../common/decorators';

interface HealthCheck {
  status: 'ok' | 'error';
  timestamp: string;
  uptime: number;
  checks?: Record<string, { status: 'ok' | 'error'; message?: string; latency?: number }>;
}

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache,
  ) {}

  @Public()
  @Get()
  async check(): Promise<HealthCheck> {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }

  @Public()
  @Get('ready')
  async readiness(): Promise<HealthCheck> {
    const checks: Record<string, { status: 'ok' | 'error'; message?: string; latency?: number }> = {};

    // Database check
    const dbStart = Date.now();
    try {
      await this.dataSource.query('SELECT 1');
      checks.database = { status: 'ok', latency: Date.now() - dbStart };
    } catch (error) {
      checks.database = {
        status: 'error',
        message: error instanceof Error ? error.message : 'Database connection failed',
      };
    }

    // Redis check
    const redisStart = Date.now();
    try {
      await this.cacheManager.set('health-check', 'ok', 1000);
      const result = await this.cacheManager.get('health-check');
      if (result === 'ok') {
        checks.redis = { status: 'ok', latency: Date.now() - redisStart };
      } else {
        checks.redis = { status: 'error', message: 'Redis read/write failed' };
      }
    } catch (error) {
      checks.redis = {
        status: 'error',
        message: error instanceof Error ? error.message : 'Redis connection failed',
      };
    }

    const hasErrors = Object.values(checks).some((c) => c.status === 'error');

    return {
      status: hasErrors ? 'error' : 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      checks,
    };
  }

  @Public()
  @Get('live')
  async liveness(): Promise<HealthCheck> {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }

  @Public()
  @Get('detailed')
  async detailed(): Promise<HealthCheck & { memory: NodeJS.MemoryUsage; version: string }> {
    const readinessCheck = await this.readiness();

    return {
      ...readinessCheck,
      memory: process.memoryUsage(),
      version: process.env.npm_package_version || '0.0.1',
    };
  }
}
