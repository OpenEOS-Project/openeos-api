import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';

import { CronLockService } from '../../common/redis/cron-lock.service';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  RetentionNotice,
  RetentionRun,
  type RetentionNoticeSubject,
} from '../../database/entities';
import { RETENTION_CONFIG, type RetentionConfig } from './retention.config';
import { select } from './retention-sql';
import {
  RETENTION_CATEGORIES,
  RETENTION_JOBS,
  type RetentionCategory,
  type RetentionJob,
  type RetentionRunContext,
  type RetentionTrigger,
} from './retention.types';

/** Wird geworfen, um die Transaktion eines Probelaufs zurueckzurollen. */
class DryRunRollback extends Error {}

export interface RunOptions {
  trigger: RetentionTrigger;
  dryRun?: boolean;
  now?: Date;
  organizationId?: string | null;
  executedByUserId?: string | null;
  reason?: string | null;
}

/** Fehlertext fuers Protokoll: Code und erste Zeile, ohne Datenwerte. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const code = (error as { code?: unknown }).code;
  const first = error.message.split('\n')[0].slice(0, 300);
  return typeof code === 'string' ? `${code}: ${first}` : first;
}

/**
 * Fuehrt die Loeschlaeufe aus und protokolliert jeden in `retention_runs`.
 *
 * Jede Datenart laeuft in einer eigenen Transaktion. Im Probelauf wird sie
 * am Ende zurueckgerollt: die Zahlen im Protokoll sind dieselben wie bei
 * einem echten Lauf, geaendert wird nichts, Mails und Dateien bleiben aus.
 * Scheitert eine Datenart, wird sie zurueckgerollt und als `failed`
 * protokolliert; die uebrigen laufen weiter.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(RetentionRun)
    private readonly runs: Repository<RetentionRun>,
    @Inject(RETENTION_CONFIG) readonly config: RetentionConfig,
    @Inject(RETENTION_JOBS) private readonly jobs: RetentionJob[],
    private readonly cronLock: CronLockService,
  ) {}

  /** Jede Nacht um 03:30 (Europe/Berlin), auf genau einer Instanz. */
  @Cron('30 3 * * *', { name: 'retention', timeZone: 'Europe/Berlin' })
  async nightly(): Promise<void> {
    if (!this.config.enabled) return;
    await this.cronLock.runExclusive('retention', async () => {
      await this.runAll({ trigger: 'scheduled' });
    });
  }

  /** Die eingestellten Datenarten in fester Reihenfolge. */
  activeCategories(): RetentionCategory[] {
    const selected = this.config.categories;
    return RETENTION_CATEGORIES.filter(
      (c) => selected.length === 0 || selected.includes(c),
    );
  }

  async runAll(
    options: RunOptions,
    categories: RetentionCategory[] = this.activeCategories(),
  ): Promise<RetentionRun[]> {
    const results: RetentionRun[] = [];
    for (const category of RETENTION_CATEGORIES) {
      if (!categories.includes(category)) continue;
      const job = this.jobs.find((j) => j.category === category);
      if (!job) continue;
      results.push(await this.runJob(job, options));
    }
    return results;
  }

  async runJob(job: RetentionJob, options: RunOptions): Promise<RetentionRun> {
    const dryRun = options.dryRun ?? this.config.dryRun;
    const now = options.now ?? new Date();
    const run = await this.runs.save(
      this.runs.create({
        category: job.category,
        trigger: options.trigger,
        dryRun,
        status: 'running',
        startedAt: new Date(),
        counts: {},
        total: 0,
        organizationId: options.organizationId ?? null,
        executedByUserId: options.executedByUserId ?? null,
        reason: options.reason ?? null,
      }),
    );

    const counts: Record<string, number> = {};
    let total = 0;
    const afterCommit: Array<() => Promise<void>> = [];
    let error: string | null = null;

    try {
      await this.dataSource.transaction(async (manager) => {
        const ctx: RetentionRunContext = {
          now,
          dryRun,
          manager,
          config: this.config,
          removed: (key, count) => {
            counts[key] = (counts[key] ?? 0) + count;
            total += count;
          },
          note: (key, count) => {
            counts[key] = (counts[key] ?? 0) + count;
          },
          afterCommit: (task) => {
            afterCommit.push(task);
          },
        };
        await job.run(ctx);
        if (dryRun) throw new DryRunRollback();
      });
    } catch (caught) {
      if (!(caught instanceof DryRunRollback)) {
        error = describeError(caught);
        this.logger.error(`Retention ${job.category} failed: ${error}`);
      }
    }

    if (!error && !dryRun) {
      for (const task of afterCommit) {
        try {
          await task();
        } catch (caught) {
          counts.fileCleanupErrors = (counts.fileCleanupErrors ?? 0) + 1;
          this.logger.warn(
            `Retention ${job.category}: file cleanup failed (${describeError(caught)})`,
          );
        }
      }
    }

    // Nach einem Fehler ist nichts geaendert worden (Rollback).
    run.status = error ? 'failed' : 'succeeded';
    run.error = error;
    run.counts = error ? {} : counts;
    run.total = error ? 0 : total;
    run.finishedAt = new Date();
    await this.runs.save(run);

    if (!error && (run.total > 0 || dryRun)) {
      this.logger.log(
        `Retention ${job.category}${dryRun ? ' (dry run)' : ''}: ${JSON.stringify(counts)}`,
      );
    }
    return run;
  }

  /** Ankuendigungen, offene zuerst. */
  async listNotices(filter: {
    open?: boolean;
    subjectType?: RetentionNoticeSubject;
    limit?: number;
  }): Promise<RetentionNotice[]> {
    const qb = this.dataSource
      .getRepository(RetentionNotice)
      .createQueryBuilder('n')
      .orderBy('n.dueAt', 'ASC')
      .take(Math.min(Math.max(filter.limit ?? 100, 1), 500));
    if (filter.open !== undefined) {
      qb.andWhere(
        filter.open
          ? 'n.executedAt IS NULL AND n.cancelledAt IS NULL'
          : '(n.executedAt IS NOT NULL OR n.cancelledAt IS NOT NULL)',
      );
    }
    if (filter.subjectType) {
      qb.andWhere('n.subjectType = :subjectType', {
        subjectType: filter.subjectType,
      });
    }
    return qb.getMany();
  }

  /**
   * „Behalten“: hebt eine offene Ankuendigung wegen Inaktivitaet auf (etwa
   * wenn der Kunde widerspricht). Der Zeitpunkt zaehlt wie eine Nutzung, die
   * Frist beginnt neu.
   */
  async keep(
    subjectType: RetentionNoticeSubject,
    subjectId: string,
  ): Promise<RetentionNotice> {
    const kind =
      subjectType === 'organization'
        ? 'organization_inactivity'
        : 'user_inactivity';
    const repo = this.dataSource.getRepository(RetentionNotice);
    const notice = await repo.findOne({
      where: {
        subjectType,
        subjectId,
        kind,
        executedAt: IsNull(),
        cancelledAt: IsNull(),
      },
    });
    if (!notice) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.RETENTION_NOTICE_NOT_FOUND,
        message: 'Keine offene Ankündigung wegen Inaktivität gefunden.',
      });
    }
    notice.cancelledAt = new Date();
    notice.cancelReason = 'kept';
    return repo.save(notice);
  }

  /** Lesende Abfrage ausserhalb eines Laufs (Vorpruefungen). */
  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return select<T>(this.dataSource.manager, sql, params);
  }

  async listRuns(filter: {
    category?: string;
    trigger?: string;
    organizationId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: RetentionRun[]; total: number }> {
    const qb = this.runs
      .createQueryBuilder('run')
      .orderBy('run.startedAt', 'DESC')
      .take(Math.min(Math.max(filter.limit ?? 50, 1), 200))
      .skip(Math.max(filter.offset ?? 0, 0));
    if (filter.category) {
      qb.andWhere('run.category = :category', { category: filter.category });
    }
    if (filter.trigger) {
      qb.andWhere('run.trigger = :trigger', { trigger: filter.trigger });
    }
    if (filter.organizationId) {
      qb.andWhere('run.organizationId = :organizationId', {
        organizationId: filter.organizationId,
      });
    }
    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }
}
