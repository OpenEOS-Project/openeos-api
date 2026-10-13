import { Inject, Injectable, Logger } from '@nestjs/common';
import { hostname } from 'os';

import { REDIS_CLIENT } from './redis.constants';
import type { RedisClient } from './redis.constants';

/** How long a claimed slot stays taken. Only has to outlast clock skew. */
const LOCK_TTL_MS = 10 * 60 * 1000;

type LockClient = Pick<RedisClient, 'set'>;

/**
 * Keeps a scheduled job (`@Cron`) to one run per due time, however many API
 * instances are up. Every instance fires the cron at the same minute; the
 * first one to claim the slot with `SET key NX PX` runs the job, the others
 * skip it.
 *
 * The key names the minute the job was due, not just the job: the lock is
 * never released, so a quick job on one instance cannot finish and free
 * the slot before a second instance gets there a few milliseconds later.
 * The TTL only tidies up.
 *
 * If Redis can not be asked, the run is skipped (and logged as an error):
 * a missed reminder mail is the lesser evil than every instance sending it.
 */
@Injectable()
export class CronLockService {
  private readonly logger = new Logger(CronLockService.name);
  private readonly owner = `${hostname()}:${process.pid}`;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: LockClient) {}

  /**
   * Runs `job` if this instance claims the slot for `name` at `dueAt`
   * (default: now). Resolves to `true` if it ran here.
   */
  async runExclusive(
    name: string,
    job: () => Promise<void>,
    dueAt: Date = new Date(),
  ): Promise<boolean> {
    const slot = dueAt.toISOString().slice(0, 16); // UTC, per minute
    const key = `openeos:cron:${name}:${slot}`;

    let claimed: boolean;
    try {
      const reply = await this.redis.set(key, this.owner, {
        condition: 'NX',
        expiration: { type: 'PX', value: LOCK_TTL_MS },
      });
      claimed = reply === 'OK';
    } catch (error) {
      this.logger.error(
        `Job "${name}" skipped: lock unavailable (${error instanceof Error ? error.message : String(error)})`,
      );
      return false;
    }

    if (!claimed) {
      this.logger.log(`Job "${name}" (${slot}) runs on another instance`);
      return false;
    }

    this.logger.log(`Job "${name}" (${slot}) runs on ${this.owner}`);
    await job();
    return true;
  }
}
