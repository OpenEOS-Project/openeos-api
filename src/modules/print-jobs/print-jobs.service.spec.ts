import {
  PrintJob,
  PrintJobStatus,
} from '../../database/entities/print-job.entity';
import { User } from '../../database/entities/user.entity';
import { PrintJobsService } from './print-jobs.service';

type AgentEvent = ReturnType<PrintJobsService['buildAgentJobEvent']>;

const ORG = 'org-1';
const PRINTER = 'printer-1';
const AGENT_DEVICE = 'agent-1';

/**
 * Minimal repository/gateway doubles. The print-job repository keeps saved
 * jobs in memory so retry() and the reconnect replay can read back exactly
 * what createFromWorkflow()/create() persisted.
 */
function setup() {
  const jobs = new Map<string, PrintJob>();
  let seq = 0;

  const printJobRepository = {
    create: jest.fn((input: Partial<PrintJob>) => ({
      id: `job-${++seq}`,
      ...input,
    })),
    save: jest.fn((job: PrintJob) => {
      jobs.set(job.id, job);
      return Promise.resolve(job);
    }),
    findOne: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(jobs.get(where.id) ?? null),
    ),
    update: jest.fn(() => Promise.resolve()),
  };
  const printerRepository = {
    findOne: jest.fn(() =>
      Promise.resolve({
        id: PRINTER,
        organizationId: ORG,
        name: 'Küche',
        isActive: true,
        deviceId: AGENT_DEVICE,
      }),
    ),
  };
  const printTemplateRepository = {
    findOne: jest.fn(() => Promise.resolve(null)),
  };
  const userOrganizationRepository = {
    findOne: jest.fn(() => Promise.resolve({ organizationId: ORG })),
  };
  const gatewayService = {
    sendPrintJobToAgent: jest.fn(
      (_org: string, _device: string | null, _event: AgentEvent) =>
        Promise.resolve(true),
    ),
  };

  const service = new PrintJobsService(
    printJobRepository as never,
    printerRepository as never,
    printTemplateRepository as never,
    userOrganizationRepository as never,
    gatewayService as never,
  );

  /** The event the agent received for the n-th dispatch (0-based). */
  const sentEvent = (n = 0): AgentEvent =>
    gatewayService.sendPrintJobToAgent.mock.calls[n][2];

  return {
    service,
    jobs,
    printJobRepository,
    printTemplateRepository,
    gatewayService,
    sentEvent,
  };
}

const user = { id: 'user-1' } as User;

const kitchenPayload = {
  station_name: 'Grill',
  items: [{ name: 'Bratwurst', quantity: 2, notes: null, options: [] }],
};

describe('PrintJobsService template resolution', () => {
  it('dispatches a workflow kitchen ticket with the workflow default template', async () => {
    const { service, sentEvent } = setup();

    const job = await service.createFromWorkflow(
      ORG,
      PRINTER,
      null,
      'order-1',
      1,
      kitchenPayload,
      null,
      'kitchen_ticket',
    );
    await Promise.resolve();

    expect(sentEvent()).toEqual({
      jobId: job.id,
      printerId: PRINTER,
      templateName: 'kitchen_ticket',
      copies: 1,
      payload: kitchenPayload,
    });
    // Persisted so later deliveries can reproduce the same event.
    expect(job.payload.templateName).toBe('kitchen_ticket');
  });

  it('replays a queued kitchen ticket with kitchen_ticket, not receipt', async () => {
    const { service, jobs, sentEvent } = setup();

    const job = await service.createFromWorkflow(
      ORG,
      PRINTER,
      null,
      'order-1',
      1,
      kitchenPayload,
      null,
      'kitchen_ticket',
    );
    await Promise.resolve();

    // Reconnect replay (AppGateway.replayQueuedPrintJobs) builds the event
    // from the persisted job — it must equal the original dispatch.
    const replayed = service.buildAgentJobEvent(jobs.get(job.id) as PrintJob);

    expect(replayed.templateName).toBe('kitchen_ticket');
    expect(replayed).toEqual(sentEvent());
  });

  it('retries a failed kitchen ticket with the original template', async () => {
    const { service, jobs, gatewayService, sentEvent } = setup();

    const job = await service.createFromWorkflow(
      ORG,
      PRINTER,
      null,
      'order-1',
      1,
      kitchenPayload,
      null,
      'kitchen_ticket',
    );
    await Promise.resolve();
    const original = sentEvent();

    // Agent reported a failure; the job is loaded with its relations.
    const stored = jobs.get(job.id) as PrintJob;
    stored.status = PrintJobStatus.FAILED;
    stored.template = null;
    stored.printer = { deviceId: AGENT_DEVICE } as never;

    const retried = await service.retry(ORG, job.id, user);
    await Promise.resolve();

    expect(retried.status).toBe(PrintJobStatus.QUEUED);
    expect(retried.attempts).toBe(1);
    expect(gatewayService.sendPrintJobToAgent).toHaveBeenCalledTimes(2);
    expect(sentEvent(1).templateName).toBe('kitchen_ticket');
    expect(sentEvent(1)).toEqual(original);
  });

  it('keeps receipts on the receipt template for dispatch, replay and retry', async () => {
    const { service, jobs, sentEvent } = setup();
    const receiptPayload = {
      items: [{ name: 'Cola', quantity: 1, total: 3.5 }],
      total: 3.5,
    };

    const job = await service.createFromWorkflow(
      ORG,
      PRINTER,
      null,
      'order-1',
      2,
      receiptPayload,
    );
    await Promise.resolve();

    expect(sentEvent()).toEqual({
      jobId: job.id,
      printerId: PRINTER,
      templateName: 'receipt',
      copies: 2,
      payload: receiptPayload,
    });

    const stored = jobs.get(job.id) as PrintJob;
    expect(service.buildAgentJobEvent(stored)).toEqual(sentEvent());

    stored.status = PrintJobStatus.FAILED;
    stored.template = null;
    stored.printer = { deviceId: AGENT_DEVICE } as never;
    await service.retry(ORG, job.id, user);
    await Promise.resolve();

    expect(sentEvent(1)).toEqual(sentEvent());
  });

  it('uses the custom template type when a templateId is given', async () => {
    const { service, jobs, printTemplateRepository, sentEvent } = setup();
    printTemplateRepository.findOne.mockResolvedValue({
      id: 'tpl-1',
      type: 'kitchen_ticket',
    } as never);

    const job = await service.createFromWorkflow(
      ORG,
      PRINTER,
      'tpl-1',
      'order-1',
      1,
      kitchenPayload,
      null,
      'order_ticket',
    );
    await Promise.resolve();

    expect(printTemplateRepository.findOne).toHaveBeenCalledWith({
      where: { id: 'tpl-1', organizationId: ORG },
    });
    expect(sentEvent().templateName).toBe('kitchen_ticket');
    expect(
      service.buildAgentJobEvent(jobs.get(job.id) as PrintJob).templateName,
    ).toBe('kitchen_ticket');
  });

  it('persists the resolved template for manually created jobs too', async () => {
    const { service, jobs, sentEvent } = setup();
    const data = { orderNumber: 'B-001', items: [], total: 25.5 };

    const job = await service.create(
      ORG,
      {
        printerId: PRINTER,
        payload: { type: 'receipt', copies: 3, data },
      },
      user,
    );
    await Promise.resolve();

    expect(sentEvent()).toEqual({
      jobId: job.id,
      printerId: PRINTER,
      templateName: 'receipt',
      copies: 3,
      payload: data,
    });
    expect(service.buildAgentJobEvent(jobs.get(job.id) as PrintJob)).toEqual(
      sentEvent(),
    );
  });

  it('falls back to the loaded template, then receipt, for jobs persisted before templateName existed', () => {
    const { service } = setup();
    const legacy = {
      id: 'legacy',
      printerId: PRINTER,
      payload: { copies: 1, data: { foo: 'bar' } },
    } as unknown as PrintJob;

    expect(
      service.buildAgentJobEvent({
        ...legacy,
        template: { type: 'order_ticket' },
      } as PrintJob).templateName,
    ).toBe('order_ticket');
    expect(service.buildAgentJobEvent(legacy).templateName).toBe('receipt');
  });
});
