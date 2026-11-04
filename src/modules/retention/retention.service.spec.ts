import { Logger } from '@nestjs/common';
import type { DataSource, EntityManager, Repository } from 'typeorm';

import type { CronLockService } from '../../common/redis/cron-lock.service';
import type { RetentionRun } from '../../database/entities';
import { loadRetentionConfig } from './retention.config';
import { RetentionService, describeError } from './retention.service';
import type { RetentionJob } from './retention.types';

/**
 * Ablauf eines Laufs ohne Datenbank: Protokoll, Rollback im Probelauf,
 * Fehlerbehandlung, Nebenwirkungen erst nach dem Commit.
 */
describe('RetentionService', () => {
  const saved: Partial<RetentionRun>[] = [];
  let rolledBack: boolean;
  let committed: boolean;

  const dataSource = {
    transaction: async (work: (m: EntityManager) => Promise<void>) => {
      try {
        await work({} as EntityManager);
        committed = true;
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    },
  } as unknown as DataSource;

  const runs = {
    create: (r: Partial<RetentionRun>) => ({ ...r }),
    save: (r: Partial<RetentionRun>) => {
      saved.push({ ...r });
      return Promise.resolve(r);
    },
  } as unknown as Repository<RetentionRun>;

  const cronLock = {
    runExclusive: async (_name: string, job: () => Promise<void>) => {
      await job();
      return true;
    },
  } as unknown as CronLockService;

  function service(jobs: RetentionJob[], env: Record<string, string> = {}) {
    return new RetentionService(
      dataSource,
      runs,
      loadRetentionConfig({ NODE_ENV: 'production', ...env }),
      jobs,
      cronLock,
    );
  }

  beforeEach(() => {
    saved.length = 0;
    rolledBack = false;
    committed = false;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('protocols counts and runs file clean-up after the commit', async () => {
    const afterCommit = jest.fn(() => Promise.resolve());
    const job: RetentionJob = {
      category: 'guest_data',
      run: (ctx) => {
        ctx.removed('ordersAnonymised', 3);
        ctx.note('noticesSent', 1);
        ctx.afterCommit(afterCommit);
        expect(afterCommit).not.toHaveBeenCalled();
        return Promise.resolve();
      },
    };

    const [run] = await service([job]).runAll({ trigger: 'scheduled' });

    expect(committed).toBe(true);
    expect(afterCommit).toHaveBeenCalledTimes(1);
    expect(run).toMatchObject({
      category: 'guest_data',
      trigger: 'scheduled',
      dryRun: false,
      status: 'succeeded',
      counts: { ordersAnonymised: 3, noticesSent: 1 },
      total: 3,
      error: null,
    });
    expect(saved[0].status).toBe('running');
    expect(run.finishedAt).toBeInstanceOf(Date);
  });

  it('rolls back a dry run and skips side effects', async () => {
    const afterCommit = jest.fn(() => Promise.resolve());
    const seenDryRun: boolean[] = [];
    const job: RetentionJob = {
      category: 'helper_data',
      run: (ctx) => {
        seenDryRun.push(ctx.dryRun);
        ctx.removed('registrationsDeleted', 5);
        ctx.afterCommit(afterCommit);
        return Promise.resolve();
      },
    };

    const [run] = await service([job], { RETENTION_DRY_RUN: 'true' }).runAll({
      trigger: 'manual',
    });

    expect(seenDryRun).toEqual([true]);
    expect(rolledBack).toBe(true);
    expect(committed).toBe(false);
    expect(afterCommit).not.toHaveBeenCalled();
    expect(run).toMatchObject({
      dryRun: true,
      status: 'succeeded',
      counts: { registrationsDeleted: 5 },
      total: 5,
    });
  });

  it('records a failed category without counts and continues with the next', async () => {
    const failing: RetentionJob = {
      category: 'guest_data',
      run: (ctx) => {
        ctx.removed('ordersAnonymised', 2);
        return Promise.reject(
          Object.assign(new Error('deadlock detected\nDETAIL: x@y.z'), {
            code: '40P01',
          }),
        );
      },
    };
    const next: RetentionJob = {
      category: 'contact_requests',
      run: (ctx) => {
        ctx.removed('requestsDeleted', 1);
        return Promise.resolve();
      },
    };

    const result = await service([failing, next]).runAll({
      trigger: 'scheduled',
    });

    expect(result.map((r) => r.status)).toEqual(['failed', 'succeeded']);
    expect(result[0]).toMatchObject({
      counts: {},
      total: 0,
      error: '40P01: deadlock detected',
    });
  });

  it('runs only the configured categories in fixed order', async () => {
    const order: string[] = [];
    const job = (category: RetentionJob['category']): RetentionJob => ({
      category,
      run: () => {
        order.push(category);
        return Promise.resolve();
      },
    });
    const jobs = [job('fiscal_archive'), job('audit_logs'), job('guest_data')];

    await service(jobs, {
      RETENTION_CATEGORIES: 'fiscal_archive,guest_data',
    }).runAll({ trigger: 'manual' });

    expect(order).toEqual(['guest_data', 'fiscal_archive']);
  });

  it('does nothing at night when disabled', async () => {
    const run = jest.fn(() => Promise.resolve());
    await service([{ category: 'guest_data', run }], {
      RETENTION_ENABLED: 'false',
    }).nightly();
    expect(run).not.toHaveBeenCalled();
  });

  it('describeError keeps only code and first line', () => {
    expect(describeError(new Error('a\nb'))).toBe('a');
    expect(describeError('x')).toBe('unknown error');
  });
});
