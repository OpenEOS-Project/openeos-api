import { ForbiddenException } from '@nestjs/common';
import { PrintHealthService } from './print-health.service';

const ORG = 'org-1';

type PrinterRow = {
  id: string;
  name: string;
  deviceId: string | null;
  isOnline: boolean;
};

function setup(
  options: {
    printers?: PrinterRow[];
    counts?: Array<Record<string, unknown>>;
    online?: string[];
    member?: boolean;
  } = {},
) {
  const query = jest.fn((_sql: string, _params: unknown[]) =>
    Promise.resolve(options.counts ?? []),
  );
  const printJobRepository = { query };
  const printerRepository = {
    find: jest.fn(() => Promise.resolve(options.printers ?? [])),
  };
  const deviceRepository = {
    find: jest.fn(() =>
      Promise.resolve([
        { id: 'agent-k', name: 'Pi Küche' },
        { id: 'agent-b', name: 'Pi Bar' },
      ]),
    ),
  };
  const gateway = {
    getOnlineDeviceIds: jest.fn(() => Promise.resolve(options.online ?? [])),
    notifyPrintHealthChanged: jest.fn((_event: Record<string, unknown>) => {}),
  };
  const memberships = {
    findOne: jest.fn(() =>
      Promise.resolve(
        options.member === false ? null : { organizationId: ORG },
      ),
    ),
  };
  const service = new PrintHealthService(
    printJobRepository as never,
    printerRepository as never,
    deviceRepository as never,
    {} as never,
    {} as never,
    memberships as never,
    gateway as never,
  );
  return { service, query, gateway, printerRepository };
}

const NOW = new Date('2026-11-20T12:00:00Z');

describe('PrintHealthService.forOrganization', () => {
  it('is ok without printers and does not query jobs', async () => {
    const { service, query } = setup();
    await expect(
      service.forOrganization(ORG, { now: NOW }),
    ).resolves.toMatchObject({
      status: 'ok',
      printers: [],
      thresholds: { waitingSeconds: 30, failedWindowMinutes: 15 },
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('is an error when jobs wait, naming the offline agent', async () => {
    const { service } = setup({
      printers: [
        { id: 'p-k', name: 'Küche', deviceId: 'agent-k', isOnline: false },
        { id: 'p-b', name: 'Bar', deviceId: 'agent-b', isOnline: true },
      ],
      online: ['agent-b'],
      counts: [
        {
          printer_id: 'p-k',
          waiting: '3',
          oldest_waiting_at: new Date('2026-11-20T11:55:00Z'),
          failed: '0',
        },
      ],
    });
    const health = await service.forOrganization(ORG, { now: NOW });
    expect(health).toMatchObject({
      status: 'error',
      waitingJobs: 3,
      failedJobs: 0,
      oldestWaitingAt: '2026-11-20T11:55:00.000Z',
      offlineAgents: [
        { deviceId: 'agent-k', name: 'Pi Küche', printerIds: ['p-k'] },
      ],
    });
    expect(health.printers).toEqual([
      {
        printerId: 'p-k',
        name: 'Küche',
        agentDeviceId: 'agent-k',
        agentName: 'Pi Küche',
        agentOnline: false,
        printerOnline: false,
        waitingJobs: 3,
        oldestWaitingAt: '2026-11-20T11:55:00.000Z',
        failedJobs: 0,
        issues: ['agent_offline', 'jobs_waiting'],
      },
    ]);
  });

  it('is a warning when only an agent or a printer is offline', async () => {
    const { service } = setup({
      printers: [
        { id: 'p-k', name: 'Küche', deviceId: 'agent-k', isOnline: true },
        { id: 'p-b', name: 'Bar', deviceId: 'agent-b', isOnline: false },
      ],
      online: ['agent-k'],
    });
    const health = await service.forOrganization(ORG, { now: NOW });
    expect(health.status).toBe('warning');
    expect(health.printers.map((p) => [p.name, p.issues])).toEqual([
      ['Bar', ['agent_offline']],
    ]);
  });

  it('counts failures, and printers without agent never count as offline', async () => {
    const { service } = setup({
      printers: [{ id: 'p-x', name: 'Alt', deviceId: null, isOnline: false }],
      counts: [
        { printer_id: 'p-x', waiting: 0, oldest_waiting_at: null, failed: 2 },
      ],
    });
    const health = await service.forOrganization(ORG, { now: NOW });
    expect(health).toMatchObject({
      status: 'error',
      failedJobs: 2,
      offlineAgents: [],
    });
    expect(health.printers[0].issues).toEqual(['jobs_failed']);
  });

  it('passes the time windows to the query', async () => {
    const { service, query } = setup({
      printers: [
        { id: 'p-k', name: 'Küche', deviceId: 'agent-k', isOnline: true },
      ],
      online: ['agent-k'],
    });
    await service.forOrganization(ORG, { now: NOW, printerIds: ['p-k'] });
    const params = query.mock.calls[0][1];
    expect(params).toEqual([
      new Date('2026-11-20T11:59:30Z'),
      new Date('2026-11-20T00:00:00Z'),
      new Date('2026-11-20T11:45:00Z'),
      'Manuell abgebrochen',
      ORG,
      ['p-k'],
    ]);
  });

  it('requires membership for the admin view', async () => {
    const { service } = setup({ member: false });
    await expect(
      service.forMember(ORG, { id: 'u' } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('PrintHealthService.publishChanges', () => {
  it('announces only changes, including the all-clear, per organization', async () => {
    const { service, query, gateway } = setup();
    const rows = (r: Array<[string, number, number]>) =>
      query.mockResolvedValueOnce(
        r.map(([organization_id, waiting, failed]) => ({
          organization_id,
          waiting: String(waiting),
          failed: String(failed),
        })),
      );

    rows([['org-a', 2, 0]]);
    expect(await service.publishChanges(NOW)).toBe(1);
    rows([['org-a', 2, 0]]);
    expect(await service.publishChanges(NOW)).toBe(0);
    rows([
      ['org-a', 2, 1],
      ['org-b', 1, 0],
    ]);
    expect(await service.publishChanges(NOW)).toBe(2);
    rows([['org-b', 1, 0]]);
    expect(await service.publishChanges(NOW)).toBe(1);
    rows([]);
    expect(await service.publishChanges(NOW)).toBe(1);
    rows([]);
    expect(await service.publishChanges(NOW)).toBe(0);

    expect(
      gateway.notifyPrintHealthChanged.mock.calls.map((c) => c[0]),
    ).toEqual([
      { organizationId: 'org-a', waitingJobs: 2, failedJobs: 0 },
      { organizationId: 'org-a', waitingJobs: 2, failedJobs: 1 },
      { organizationId: 'org-b', waitingJobs: 1, failedJobs: 0 },
      { organizationId: 'org-a', waitingJobs: 0, failedJobs: 0 },
      { organizationId: 'org-b', waitingJobs: 0, failedJobs: 0 },
    ]);
  });
});
