import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { CronLockService } from '../../common/redis/cron-lock.service';
import type { PrintJob } from '../../database/entities';
import { GatewayService } from '../gateway/gateway.service';
import {
  PRINT_HEALTH_OPEN_MAX_AGE_MS,
  PrintHealthService,
} from './print-health.service';
import { PrintJobsService } from './print-jobs.service';

/** Queued jobs untouched this long are sent again (initial ack: 10 s). */
export const REDELIVERY_IDLE_MS = 20_000;
/**
 * A job acked by an idempotent agent but without outcome after this long
 * is sent again. The agent's own retries take well under a minute
 * (2 + 10 + 30 s); a second delivery of a job it still holds is only
 * acked, one it already printed is answered with the outcome again.
 */
export const REDELIVERY_STALE_PRINTING_MS = 3 * 60_000;
/**
 * Never redeliver jobs older than this: the agent dedupes by job id for
 * about 24 h, and a ticket from many hours ago is no use in the kitchen.
 */
export const REDELIVERY_MAX_AGE_MS = PRINT_HEALTH_OPEN_MAX_AGE_MS;
/** Upper bound of jobs sent per run. */
export const REDELIVERY_BATCH = 200;

export interface RedeliveryResult {
  agents: number;
  requeued: number;
  sent: number;
  acked: number;
}

/**
 * Periodic redelivery of print jobs to connected printer agents (every
 * 30 s, on one instance at a time via CronLockService). Before, jobs were
 * only sent when created and replayed when an agent (re)connected — a job
 * whose delivery got lost while the agent stayed connected waited until
 * the next reconnect, possibly hours later.
 *
 * - QUEUED jobs (never acked) go to every connected agent, as the replay
 *   on connect already does.
 * - PRINTING jobs without outcome for 3 minutes go back to QUEUED and are
 *   sent again — but only to agents announcing
 *   `capabilities.idempotentJobs` on all of their sockets. Older agents
 *   forget a job once they reported it; sending it again could print it
 *   twice. For them the old behaviour stays: stale PRINTING jobs are only
 *   replayed when the agent reconnects.
 */
@Injectable()
export class PrintJobRedeliveryService {
  private readonly logger = new Logger(PrintJobRedeliveryService.name);

  constructor(
    private readonly printJobsService: PrintJobsService,
    @Inject(forwardRef(() => GatewayService))
    private readonly gatewayService: GatewayService,
    private readonly cronLock: CronLockService,
    private readonly printHealth: PrintHealthService,
  ) {}

  /**
   * Twice a minute. CronLockService claims slots per minute, so each half
   * minute has its own lock name.
   */
  @Cron('5,35 * * * * *', { name: 'print-job-redelivery' })
  async tick(): Promise<void> {
    const now = new Date();
    const half = now.getUTCSeconds() < 30 ? 'a' : 'b';
    try {
      await this.cronLock.runExclusive(
        `print-job-redelivery-${half}`,
        async () => {
          await this.run(now);
          await this.printHealth.publishChanges(now);
        },
        now,
        // Twice a minute: the "runs on" line would flood the log.
        { quiet: true },
      );
    } catch (error) {
      this.logger.warn(
        `Print job redelivery failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async run(now: Date = new Date()): Promise<RedeliveryResult> {
    const agents = await this.gatewayService.getConnectedPrinterAgents();
    const result: RedeliveryResult = {
      agents: agents.length,
      requeued: 0,
      sent: 0,
      acked: 0,
    };
    if (agents.length === 0) return result;

    const byDevice = new Map(agents.map((a) => [a.deviceId, a]));
    const idempotent = agents
      .filter((a) => a.idempotentJobs)
      .map((a) => a.deviceId);

    const requeuedIds = await this.printJobsService.requeueStalePrintingJobs(
      idempotent,
      now,
      REDELIVERY_STALE_PRINTING_MS,
      REDELIVERY_MAX_AGE_MS,
    );
    result.requeued = requeuedIds.length;
    if (requeuedIds.length > 0) {
      this.logger.warn(
        `Re-queued ${requeuedIds.length} print job(s) without outcome for ${
          REDELIVERY_STALE_PRINTING_MS / 60_000
        } min`,
      );
    }

    const [requeued, queued] = await Promise.all([
      this.printJobsService.findJobsWithPrinter(requeuedIds),
      this.printJobsService.findQueuedJobsForRedelivery(
        [...byDevice.keys()],
        now,
        REDELIVERY_IDLE_MS,
        REDELIVERY_MAX_AGE_MS,
        REDELIVERY_BATCH,
      ),
    ]);

    const jobs = new Map<string, PrintJob>();
    for (const job of [...requeued, ...queued]) {
      if (jobs.size >= REDELIVERY_BATCH) break;
      jobs.set(job.id, job);
    }

    const deliveries: Promise<boolean>[] = [];
    for (const job of jobs.values()) {
      const deviceId = job.printer?.deviceId;
      const agent = deviceId ? byDevice.get(deviceId) : undefined;
      // Only the agent of the job's own organization gets it.
      if (!agent || agent.organizationId !== job.organizationId) continue;
      deliveries.push(this.deliver(job, agent.deviceId));
    }
    result.sent = deliveries.length;
    const outcomes = await Promise.all(deliveries);
    result.acked = outcomes.filter(Boolean).length;

    if (result.sent > 0) {
      this.logger.log(
        `Redelivered ${result.sent} print job(s), ${result.acked} acked`,
      );
    }
    return result;
  }

  private async deliver(job: PrintJob, deviceId: string): Promise<boolean> {
    try {
      const acked = await this.gatewayService.sendPrintJobToAgent(
        job.organizationId,
        deviceId,
        this.printJobsService.buildAgentJobEvent(job),
      );
      if (acked) await this.printJobsService.markJobPrinting(job.id);
      return acked;
    } catch (error) {
      this.logger.warn(
        `Redelivery of print job ${job.id} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }
}
