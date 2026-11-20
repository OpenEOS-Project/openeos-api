import { Logger } from '@nestjs/common';
import { AppGateway, announcesIdempotentJobs } from './app.gateway';
import {
  DeviceStatus,
  DeviceType,
} from '../../database/entities/device.entity';
import { GatewayEvents } from './dto';

const ORG = '11111111-1111-4111-8111-111111111111';
const AGENT = 'agent-1';

/**
 * Print-job protocol between API and printer agent: capability
 * announcement (`idempotentJobs`), idempotent job reports with the
 * optional `attempts` / `printedAt`, and the lookup of connected agents
 * the redelivery uses.
 */
function setup(serverSockets: Array<{ data: Record<string, unknown> }> = []) {
  const printerAgentsService = {
    handleAgentHeartbeat: jest.fn(() => Promise.resolve()),
    markAgentOffline: jest.fn(() => Promise.resolve()),
  };
  const printJobsService = {
    updateJobStatus: jest.fn(
      (): Promise<{ job: { printerId: string }; changed: boolean } | null> =>
        Promise.resolve({ job: { printerId: 'p-1' }, changed: true }),
    ),
    agentTemplates: jest.fn(() => Promise.resolve({})),
    getQueuedJobsForDevice: jest.fn(() => Promise.resolve([])),
  };
  const devicesService = {
    findByToken: jest.fn(() =>
      Promise.resolve({
        id: AGENT,
        name: 'Agent',
        type: DeviceType.PRINTER_AGENT,
        status: DeviceStatus.VERIFIED,
        isActive: true,
        organizationId: ORG,
        organization: { id: ORG, deletedAt: null },
      }),
    ),
    updateLastSeen: jest.fn(() => Promise.resolve()),
  };
  const none = undefined as never;
  const gateway = new AppGateway(
    none,
    { get: jest.fn() } as never,
    devicesService as never,
    none,
    printerAgentsService as never,
    printJobsService as never,
    none,
    none,
    none,
  );
  const emit = jest.fn();
  gateway.server = {
    to: jest.fn(() => ({ emit })),
    in: jest.fn(() => ({ fetchSockets: () => Promise.resolve([]) })),
    fetchSockets: jest.fn(() => Promise.resolve(serverSockets)),
  } as never;
  return { gateway, emit, printJobsService, printerAgentsService };
}

function agentSocket(auth: Record<string, unknown> = {}) {
  return {
    id: 'sock-1',
    handshake: { headers: {}, address: '127.0.0.1', auth, query: {} },
    data: {} as Record<string, unknown>,
    rooms: new Set<string>(),
    join: jest.fn(),
    leave: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn(),
    timeout: jest.fn(),
    device: undefined as
      | { id: string; organizationId: string; type: string }
      | undefined,
  };
}

function connectedAgent() {
  const s = agentSocket();
  s.device = { id: AGENT, organizationId: ORG, type: DeviceType.PRINTER_AGENT };
  s.data = {
    deviceId: AGENT,
    organizationId: ORG,
    deviceType: DeviceType.PRINTER_AGENT,
  };
  return s;
}

beforeAll(() => {
  for (const level of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});

afterEach(() => jest.useRealTimers());

describe('announcesIdempotentJobs', () => {
  it('only accepts a literal true', () => {
    expect(
      announcesIdempotentJobs({ capabilities: { idempotentJobs: true } }),
    ).toBe(true);
    for (const value of [
      undefined,
      null,
      'true',
      {},
      { capabilities: null },
      { capabilities: { idempotentJobs: 'true' } },
      { capabilities: { idempotentJobs: 1 } },
      { capabilities: { usb: true } },
    ]) {
      expect(announcesIdempotentJobs(value)).toBe(false);
    }
  });
});

describe('AppGateway — agent capabilities', () => {
  it('reads idempotentJobs from the agent heartbeat onto the socket', async () => {
    const { gateway, printerAgentsService } = setup();
    const s = connectedAgent();

    await gateway.handleAgentHeartbeat(s as never, {
      version: '0.3.0',
      capabilities: { usb: true, idempotentJobs: true },
    });
    expect(s.data.idempotentJobs).toBe(true);
    expect(printerAgentsService.handleAgentHeartbeat).toHaveBeenCalled();

    // A downgraded agent on the same socket stops announcing it.
    await gateway.handleAgentHeartbeat(s as never, {
      version: '0.2.6',
      capabilities: { usb: true },
    });
    expect(s.data.idempotentJobs).toBe(false);
  });

  it('accepts the capability in the handshake as well', async () => {
    const { gateway } = setup();
    jest.useFakeTimers();
    const s = agentSocket({
      deviceToken: 'tok',
      capabilities: { idempotentJobs: true },
    });
    await gateway.handleConnection(s as never);
    expect(s.data.deviceType).toBe(DeviceType.PRINTER_AGENT);
    expect(s.data.idempotentJobs).toBe(true);

    // Old agents send only the token: not idempotent.
    const old = agentSocket({ deviceToken: 'tok' });
    await gateway.handleConnection(old as never);
    expect(old.data.idempotentJobs).toBe(false);

    await gateway.handleDisconnect(s as never);
    await gateway.handleDisconnect(old as never);
  });
});

describe('AppGateway.getConnectedPrinterAgents', () => {
  it('lists printer agents with org; idempotent only if every socket says so', async () => {
    const agent = (deviceId: string, extra: Record<string, unknown> = {}) => ({
      data: {
        deviceId,
        organizationId: ORG,
        deviceType: DeviceType.PRINTER_AGENT,
        ...extra,
      },
    });
    const { gateway } = setup([
      agent('new', { idempotentJobs: true }),
      agent('old'),
      // Reconnect overlap: old socket of the same device still there.
      agent('mixed', { idempotentJobs: true }),
      agent('mixed'),
      agent('new2', { idempotentJobs: true }),
      agent('new2', { idempotentJobs: true }),
      // Not printer agents / not assigned:
      { data: { deviceId: 'pos', organizationId: ORG, deviceType: 'pos' } },
      agent('unassigned', { organizationId: '' }),
      { data: {} },
    ]);

    const agents = await gateway.getConnectedPrinterAgents();
    expect(agents).toEqual([
      { deviceId: 'new', organizationId: ORG, idempotentJobs: true },
      { deviceId: 'old', organizationId: ORG, idempotentJobs: false },
      { deviceId: 'mixed', organizationId: ORG, idempotentJobs: false },
      { deviceId: 'new2', organizationId: ORG, idempotentJobs: true },
    ]);
  });
});

describe('AppGateway — job reports', () => {
  it('passes attempts and printedAt on to the job and notifies the org', async () => {
    const { gateway, printJobsService, emit } = setup();
    const s = connectedAgent();

    await expect(
      gateway.handlePrinterJobComplete(s as never, {
        jobId: 'j-1',
        agentId: AGENT,
        attempts: 2,
        printedAt: '2026-11-20T12:00:03Z',
      }),
    ).resolves.toEqual({ success: true });
    expect(printJobsService.updateJobStatus).toHaveBeenCalledWith(
      'j-1',
      'completed',
      undefined,
      ORG,
      { attempts: 2, printedAt: '2026-11-20T12:00:03Z' },
    );
    expect(emit).toHaveBeenCalledWith(
      GatewayEvents.PRINT_JOB_STATUS_CHANGED,
      expect.objectContaining({ jobId: 'j-1', status: 'completed' }),
    );
  });

  it('passes attempts of a failure on', async () => {
    const { gateway, printJobsService } = setup();
    await gateway.handlePrinterJobFailed(connectedAgent() as never, {
      jobId: 'j-1',
      agentId: AGENT,
      errorCode: 'PRINTER_OFFLINE',
      errorMessage: 'no paper',
      attempts: 4,
    });
    expect(printJobsService.updateJobStatus).toHaveBeenCalledWith(
      'j-1',
      'failed',
      'PRINTER_OFFLINE: no paper',
      ORG,
      { attempts: 4 },
    );
  });

  it('acks a repeated report with success but does not notify again', async () => {
    const { gateway, printJobsService, emit } = setup();
    printJobsService.updateJobStatus.mockResolvedValue({
      job: { printerId: 'p-1' },
      changed: false,
    });
    const s = connectedAgent();

    await expect(
      gateway.handlePrinterJobComplete(s as never, {
        jobId: 'j-1',
        agentId: AGENT,
      }),
    ).resolves.toEqual({ success: true });
    await expect(
      gateway.handlePrinterJobFailed(s as never, {
        jobId: 'j-1',
        agentId: AGENT,
        errorCode: 'X',
        errorMessage: 'late',
      }),
    ).resolves.toEqual({ success: true });
    expect(emit).not.toHaveBeenCalled();
  });

  it('answers unknown jobs with an error (agent keeps nothing to resend)', async () => {
    const { gateway, printJobsService } = setup();
    printJobsService.updateJobStatus.mockResolvedValue(null);
    await expect(
      gateway.handlePrinterJobComplete(connectedAgent() as never, {
        jobId: 'gone',
        agentId: AGENT,
      }),
    ).resolves.toEqual({ error: 'Job not found' });
  });
});
