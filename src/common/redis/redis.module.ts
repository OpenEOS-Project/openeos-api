import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';

import { CronLockService } from './cron-lock.service';
import { REDIS_CLIENT, redisUrl } from './redis.constants';
import type { RedisClient } from './redis.constants';

/**
 * Closes the shared client after the HTTP server has stopped — Nest runs
 * `onApplicationShutdown` last, so requests still in flight keep their
 * Redis connection until they are done.
 */
@Injectable()
class RedisShutdown implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly client: RedisClient) {}

  async onApplicationShutdown() {
    if (this.client.isOpen) {
      await this.client.quit().catch(() => undefined);
    }
  }
}

/**
 * One Redis connection for small coordination tasks: the readiness probe
 * and the lock that keeps scheduled jobs on a single API instance.
 *
 * `disableOfflineQueue`: while Redis is unreachable, commands fail at once
 * instead of piling up until it is back — a health check or a lock has to
 * answer now, not in five minutes.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: async (config: ConfigService): Promise<RedisClient> => {
        const logger = new Logger('Redis');
        const client = createClient({
          url: redisUrl(
            config.get<string>('redis.host') || 'localhost',
            config.get<number>('redis.port') || 6379,
            process.env.REDIS_PASSWORD || undefined,
          ),
          disableOfflineQueue: true,
          socket: {
            reconnectStrategy: (retries: number) =>
              Math.min(200 * 2 ** retries, 5000),
          },
        });
        client.on('error', (err: Error) =>
          logger.error(`Redis client: ${err.message}`),
        );
        await client.connect();
        return client;
      },
    },
    RedisShutdown,
    CronLockService,
  ],
  exports: [REDIS_CLIENT, CronLockService],
})
export class RedisModule {}
