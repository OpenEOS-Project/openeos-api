import { AppGateway } from './app.gateway';
import { DeviceType } from '../../database/entities/device.entity';
import { PrintJob } from '../../database/entities/print-job.entity';
import { PrintJobsService } from '../print-jobs/print-jobs.service';
import { GatewayEvents } from './dto';

const ORG = 'org-1';
const AGENT = 'agent-1';

function setup(remainingSockets = 0) {
  const fetchSockets = jest.fn(() =>
    Promise.resolve(Array.from({ length: remainingSockets }, () => ({}))),
  );
  const server = { in: jest.fn(() => ({ fetchSockets })) };
  const printerAgentsService = {
    markAgentOffline: jest.fn(() => Promise.resolve()),
  };
  const printJobsService = {
    getQueuedJobsForDevice: jest.fn(() => Promise.resolve([] as PrintJob[])),
    // The real builder: replay must send what the original dispatch sent.
    buildAgentJobEvent: (job: PrintJob) =>
      PrintJobsService.prototype.buildAgentJobEvent.call(undefined, job),
    markJobPrinting: jest.fn(() => Promise.resolve()),
  };
  const none = undefined as never;
  const gateway = new AppGateway(
    none,
    none,
    none,
    none,
    printerAgentsService as never,
    printJobsService as never,
    none,
  );
  gateway.server = server as never;
  return { gateway, server, printerAgentsService, printJobsService };
}

function client(device?: { id: string; organizationId: string; type: string }) {
  return { id: 'sock-1', device } as never;
}

describe('AppGateway.handleDisconnect', () => {
  it('marks the printers of a disconnected printer agent offline', async () => {
    const { gateway, server, printerAgentsService } = setup();

    await gateway.handleDisconnect(
      client({
        id: AGENT,
        organizationId: ORG,
        type: DeviceType.PRINTER_AGENT,
      }),
    );

    // Presence is checked on the agent's device room, not the org room.
    expect(server.in).toHaveBeenCalledWith(`device:${AGENT}`);
    expect(printerAgentsService.markAgentOffline).toHaveBeenCalledWith(
      AGENT,
      ORG,
    );
  });

  it('leaves the printers alone while another socket of the agent is connected', async () => {
    const { gateway, printerAgentsService } = setup(1);

    await gateway.handleDisconnect(
      client({
        id: AGENT,
        organizationId: ORG,
        type: DeviceType.PRINTER_AGENT,
      }),
    );

    expect(printerAgentsService.markAgentOffline).not.toHaveBeenCalled();
  });

  it('ignores other device types and agents without organization', async () => {
    const { gateway, server, printerAgentsService } = setup();

    await gateway.handleDisconnect(
      client({ id: 'pos-1', organizationId: ORG, type: DeviceType.POS }),
    );
    await gateway.handleDisconnect(
      client({ id: AGENT, organizationId: '', type: DeviceType.PRINTER_AGENT }),
    );
    await gateway.handleDisconnect(client());

    expect(server.in).not.toHaveBeenCalled();
    expect(printerAgentsService.markAgentOffline).not.toHaveBeenCalled();
  });

  it('does not throw when marking offline fails', async () => {
    const { gateway, printerAgentsService } = setup();
    printerAgentsService.markAgentOffline.mockRejectedValue(
      new Error('db down') as never,
    );

    await expect(
      gateway.handleDisconnect(
        client({
          id: AGENT,
          organizationId: ORG,
          type: DeviceType.PRINTER_AGENT,
        }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('AppGateway print job replay on reconnect', () => {
  it('re-sends queued jobs with their persisted template name (not receipt)', async () => {
    const { gateway, printJobsService } = setup();
    const data = { station_name: 'Grill', items: [{ name: 'Bratwurst' }] };
    printJobsService.getQueuedJobsForDevice.mockResolvedValue([
      {
        id: 'job-1',
        printerId: 'printer-1',
        template: null,
        payload: { copies: 1, templateName: 'kitchen_ticket', data },
      } as unknown as PrintJob,
    ]);
    const emit = jest.fn();
    const client = { timeout: jest.fn(() => ({ emit })) };

    await (
      gateway as unknown as {
        replayQueuedPrintJobs(c: unknown, d: string): Promise<void>;
      }
    ).replayQueuedPrintJobs(client, AGENT);

    expect(printJobsService.getQueuedJobsForDevice).toHaveBeenCalledWith(AGENT);
    expect(emit).toHaveBeenCalledWith(
      GatewayEvents.PRINTER_JOB,
      {
        jobId: 'job-1',
        printerId: 'printer-1',
        templateName: 'kitchen_ticket',
        copies: 1,
        payload: data,
      },
      expect.any(Function),
    );
  });
});
