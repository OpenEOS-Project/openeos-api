import { Logger } from '@nestjs/common';
import { PrintJobStatus } from '../../database/entities/print-job.entity';
import { ADMIN_TEST_PRINT_TYPE, PrintersService } from './printers.service';

const ORG = 'org-1';

/**
 * Testdruck aus der Verwaltung: ein gespeicherter Druckauftrag ohne
 * Bestellung, damit die Rueckmeldung des Agenten ihn findet. Der Agent
 * bekommt dasselbe Ereignis wie bisher (alte Agenten unveraendert).
 */
function setup(
  options: { ack?: boolean; deviceId?: string | null; isOnline?: boolean } = {},
) {
  const printer = {
    id: 'p-1',
    name: 'Küche',
    organizationId: ORG,
    deviceId: options.deviceId === undefined ? 'agent-1' : options.deviceId,
    isActive: true,
    isOnline: options.isOnline ?? true,
    lastSeenAt: new Date(),
  };
  const printerRepository = {
    findOne: jest.fn(() => Promise.resolve(printer)),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
  };
  const saved: Array<Record<string, unknown>> = [];
  const printJobRepository = {
    create: jest.fn((input: Record<string, unknown>) => input),
    save: jest.fn((job: Record<string, unknown>) => {
      saved.push(job);
      return Promise.resolve(job);
    }),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
  };
  const gatewayService = {
    sendPrintJobToAgent: jest.fn(() => Promise.resolve(options.ack ?? true)),
  };
  const none = undefined as never;
  const service = new PrintersService(
    printerRepository as never,
    none,
    none,
    gatewayService as never,
    none,
    none,
    printJobRepository as never,
  );
  return { service, saved, printJobRepository, gatewayService };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

describe('PrintersService test print', () => {
  it('stores a job without order and sends the same event as before', async () => {
    const { service, saved, gatewayService, printJobRepository } = setup();

    const result = await service.testPrintAsAdmin('p-1');
    await flush();

    expect(result.success).toBe(true);
    expect(typeof result.jobId).toBe('string');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      id: result.jobId,
      organizationId: ORG,
      printerId: 'p-1',
      orderId: null,
      status: PrintJobStatus.QUEUED,
      payload: {
        type: ADMIN_TEST_PRINT_TYPE,
        templateName: '_admin_test',
        copies: 1,
        data: { printerName: 'Küche', jobId: result.jobId },
      },
    });
    expect(gatewayService.sendPrintJobToAgent).toHaveBeenCalledWith(
      ORG,
      'agent-1',
      {
        jobId: result.jobId,
        printerId: 'p-1',
        templateName: '_admin_test',
        copies: 1,
        payload: {
          printerName: 'Küche',
          jobId: result.jobId,
          timestamp: (saved[0].payload as { data: { timestamp: string } }).data
            .timestamp,
          body: 'Testdruck aus OpenEOS.',
        },
      },
    );
    // Acked: printing, until the agent reports.
    expect(printJobRepository.update).toHaveBeenCalledWith(
      { id: result.jobId, status: PrintJobStatus.QUEUED },
      { status: PrintJobStatus.PRINTING },
    );
  });

  it('marks the job failed right away when the agent does not ack', async () => {
    const { service, printJobRepository } = setup({ ack: false });
    const result = await service.testPrintAsAdmin('p-1');
    await flush();
    expect(printJobRepository.update).toHaveBeenCalledWith(
      { id: result.jobId, status: PrintJobStatus.QUEUED },
      {
        status: PrintJobStatus.FAILED,
        error: 'Drucker-Agent hat den Testdruck nicht angenommen',
      },
    );
  });

  it('keeps the broadcast for printers without agent device (no ack there)', async () => {
    const { service, printJobRepository, gatewayService } = setup({
      ack: false,
      deviceId: null,
    });
    const result = await service.testPrintAsAdmin('p-1');
    await flush();
    expect(gatewayService.sendPrintJobToAgent).toHaveBeenCalledWith(
      ORG,
      null,
      expect.anything(),
    );
    expect(printJobRepository.update).toHaveBeenCalledWith(
      { id: result.jobId, status: PrintJobStatus.QUEUED },
      { status: PrintJobStatus.PRINTING },
    );
  });

  it('stores nothing when the printer cannot print', async () => {
    // Organization test print requires the printer to be online.
    const offline = setup({ isOnline: false });
    jest
      .spyOn(offline.service, 'findOne')
      .mockResolvedValue({ isActive: true, isOnline: false } as never);
    jest
      .spyOn(
        offline.service as unknown as {
          checkPermission: () => Promise<void>;
        },
        'checkPermission',
      )
      .mockResolvedValue(undefined);

    await expect(
      offline.service.testPrint(ORG, 'p-1', { id: 'u' } as never),
    ).resolves.toMatchObject({ success: false });
    expect(offline.saved).toHaveLength(0);
    expect(offline.gatewayService.sendPrintJobToAgent).not.toHaveBeenCalled();
  });
});
