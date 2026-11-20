import { Logger } from '@nestjs/common';
import type { PrintJob } from '../../database/entities';
import { PrintJobStatus } from '../../database/entities/print-job.entity';
import {
  PrintJobRedeliveryService,
  REDELIVERY_BATCH,
  REDELIVERY_IDLE_MS,
  REDELIVERY_MAX_AGE_MS,
  REDELIVERY_STALE_PRINTING_MS,
} from './print-job-redelivery.service';
import { PrintJobsService } from './print-jobs.service';

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const NOW = new Date('2026-11-20T12:00:05Z');

type Agent = {
  deviceId: string;
  organizationId: string;
  idempotentJobs: boolean;
};

function job(
  id: string,
  deviceId: string | null,
  organizationId = ORG,
): PrintJob {
  return {
    id,
    organizationId,
    printerId: `printer-of-${deviceId}`,
    status: PrintJobStatus.QUEUED,
    payload: {
      type: 'kitchen',
      templateName: 'kitchen_ticket',
      copies: 1,
      data: { items: [] },
    },
    template: null,
    printer: deviceId ? ({ deviceId } as never) : (null as never),
  } as unknown as PrintJob;
}

function setup(
  options: {
    agents?: Agent[];
    queued?: PrintJob[];
    stale?: PrintJob[];
    ack?: (jobId: string) => boolean | Promise<boolean>;
  } = {},
) {
  const stale = options.stale ?? [];
  const printJobs = {
    requeueStalePrintingJobs: jest.fn((deviceIds: string[]) =>
      Promise.resolve(
        stale
          .filter((j) => deviceIds.includes(j.printer?.deviceId as string))
          .map((j) => j.id),
      ),
    ),
    findJobsWithPrinter: jest.fn((ids: string[]) =>
      Promise.resolve(stale.filter((j) => ids.includes(j.id))),
    ),
    findQueuedJobsForRedelivery: jest.fn((deviceIds: string[]) =>
      Promise.resolve(
        (options.queued ?? []).filter((j) =>
          deviceIds.includes(j.printer?.deviceId as string),
        ),
      ),
    ),
    markJobPrinting: jest.fn(() => Promise.resolve()),
    buildAgentJobEvent: (j: PrintJob) =>
      PrintJobsService.prototype.buildAgentJobEvent.call(undefined, j),
  };
  const gateway = {
    getConnectedPrinterAgents: jest.fn(() =>
      Promise.resolve(options.agents ?? []),
    ),
    sendPrintJobToAgent: jest.fn(
      (_org: string, _device: string | null, event: { jobId: string }) =>
        Promise.resolve(options.ack ? options.ack(event.jobId) : true),
    ),
  };
  const cronLock = {
    runExclusive: jest.fn(
      async (_name: string, fn: () => Promise<void>, _due?: Date) => {
        await fn();
        return true;
      },
    ),
  };
  const health = { publishChanges: jest.fn(() => Promise.resolve(0)) };
  const service = new PrintJobRedeliveryService(
    printJobs as never,
    gateway as never,
    cronLock as never,
    health as never,
  );
  const sentJobIds = () =>
    gateway.sendPrintJobToAgent.mock.calls.map((c) => c[2].jobId);
  return { service, printJobs, gateway, cronLock, health, sentJobIds };
}

beforeAll(() => {
  for (const level of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});

afterEach(() => jest.useRealTimers());

describe('PrintJobRedeliveryService.run', () => {
  it('does nothing without connected agents', async () => {
    const { service, printJobs, gateway } = setup();
    await expect(service.run(NOW)).resolves.toEqual({
      agents: 0,
      requeued: 0,
      sent: 0,
      acked: 0,
    });
    expect(printJobs.requeueStalePrintingJobs).not.toHaveBeenCalled();
    expect(gateway.sendPrintJobToAgent).not.toHaveBeenCalled();
  });

  it('redelivers queued jobs to an old agent but never re-queues its printing jobs', async () => {
    const old: Agent = {
      deviceId: 'old',
      organizationId: ORG,
      idempotentJobs: false,
    };
    const { service, printJobs, gateway, sentJobIds } = setup({
      agents: [old],
      queued: [job('q-1', 'old'), job('q-2', 'old')],
      stale: [job('s-1', 'old')],
    });

    const result = await service.run(NOW);

    // Capability gating: no idempotent agent → nothing is re-queued.
    expect(printJobs.requeueStalePrintingJobs).toHaveBeenCalledWith(
      [],
      NOW,
      REDELIVERY_STALE_PRINTING_MS,
      REDELIVERY_MAX_AGE_MS,
    );
    expect(printJobs.findQueuedJobsForRedelivery).toHaveBeenCalledWith(
      ['old'],
      NOW,
      REDELIVERY_IDLE_MS,
      REDELIVERY_MAX_AGE_MS,
      REDELIVERY_BATCH,
    );
    expect(sentJobIds()).toEqual(['q-1', 'q-2']);
    expect(gateway.sendPrintJobToAgent).toHaveBeenCalledWith(
      ORG,
      'old',
      expect.objectContaining({ jobId: 'q-1', templateName: 'kitchen_ticket' }),
    );
    expect(printJobs.markJobPrinting.mock.calls).toEqual([['q-1'], ['q-2']]);
    expect(result).toEqual({ agents: 1, requeued: 0, sent: 2, acked: 2 });
  });

  it('re-queues and resends stale printing jobs only for idempotent agents', async () => {
    const { service, printJobs, sentJobIds } = setup({
      agents: [
        { deviceId: 'new', organizationId: ORG, idempotentJobs: true },
        { deviceId: 'old', organizationId: ORG, idempotentJobs: false },
      ],
      queued: [job('q-old', 'old')],
      stale: [job('s-new', 'new'), job('s-old', 'old')],
    });

    const result = await service.run(NOW);

    expect(printJobs.requeueStalePrintingJobs).toHaveBeenCalledWith(
      ['new'],
      NOW,
      REDELIVERY_STALE_PRINTING_MS,
      REDELIVERY_MAX_AGE_MS,
    );
    expect(printJobs.findJobsWithPrinter).toHaveBeenCalledWith(['s-new']);
    expect(sentJobIds().sort()).toEqual(['q-old', 's-new']);
    expect(sentJobIds()).not.toContain('s-old');
    expect(result.requeued).toBe(1);
  });

  it('sends a job that is both re-queued and listed as queued only once', async () => {
    const stale = job('s-1', 'new');
    const { service, sentJobIds } = setup({
      agents: [{ deviceId: 'new', organizationId: ORG, idempotentJobs: true }],
      queued: [stale],
      stale: [stale],
    });
    await service.run(NOW);
    expect(sentJobIds()).toEqual(['s-1']);
  });

  it('keeps unacked jobs queued', async () => {
    const { service, printJobs } = setup({
      agents: [{ deviceId: 'a', organizationId: ORG, idempotentJobs: false }],
      queued: [job('ok', 'a'), job('lost', 'a')],
      ack: (id) => id === 'ok',
    });
    const result = await service.run(NOW);
    expect(printJobs.markJobPrinting.mock.calls).toEqual([['ok']]);
    expect(result).toMatchObject({ sent: 2, acked: 1 });
  });

  it('never sends a job to an agent of another organization', async () => {
    const { service, gateway } = setup({
      agents: [{ deviceId: 'a', organizationId: ORG, idempotentJobs: true }],
      queued: [job('foreign', 'a', OTHER_ORG)],
    });
    await service.run(NOW);
    expect(gateway.sendPrintJobToAgent).not.toHaveBeenCalled();
  });

  it('survives a failing delivery', async () => {
    const { service, printJobs } = setup({
      agents: [{ deviceId: 'a', organizationId: ORG, idempotentJobs: false }],
      queued: [job('boom', 'a'), job('fine', 'a')],
      ack: (id) => {
        if (id === 'boom') throw new Error('socket gone');
        return true;
      },
    });
    await expect(service.run(NOW)).resolves.toMatchObject({
      sent: 2,
      acked: 1,
    });
    expect(printJobs.markJobPrinting.mock.calls).toEqual([['fine']]);
  });
});

describe('PrintJobRedeliveryService.tick', () => {
  it('runs under a per-half-minute cron lock and announces health changes', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-20T12:00:05Z') });
    const { service, cronLock, health, gateway } = setup();

    await service.tick();
    jest.setSystemTime(new Date('2026-11-20T12:00:35Z'));
    await service.tick();

    expect(cronLock.runExclusive.mock.calls.map((c) => c[0])).toEqual([
      'print-job-redelivery-a',
      'print-job-redelivery-b',
    ]);
    expect(gateway.getConnectedPrinterAgents).toHaveBeenCalledTimes(2);
    expect(health.publishChanges).toHaveBeenCalledTimes(2);
  });

  it('skips the run when another instance holds the slot', async () => {
    const { service, cronLock, gateway } = setup();
    cronLock.runExclusive.mockResolvedValue(false);
    await service.tick();
    expect(gateway.getConnectedPrinterAgents).not.toHaveBeenCalled();
  });

  it('does not throw when the run fails', async () => {
    const { service, gateway } = setup();
    gateway.getConnectedPrinterAgents.mockRejectedValue(
      new Error('redis down'),
    );
    await expect(service.tick()).resolves.toBeUndefined();
  });
});
