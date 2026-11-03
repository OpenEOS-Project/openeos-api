import { Logger } from '@nestjs/common';

import { TseOutageService } from './tse-outage.service';

beforeAll(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});

/** Simuliert tse_outages mit dem Teilindex „ein offener Ausfall je TSE“. */
function setup() {
  const outages: Array<{
    id: string;
    unit: string;
    ended: boolean;
    count: number;
    notified: boolean;
  }> = [];
  const repository = {
    query: jest.fn((sql: string, params: unknown[]) => {
      if (sql.startsWith('INSERT INTO tse_outages')) {
        const unit = params[1] as string;
        const open = outages.find((o) => o.unit === unit && !o.ended);
        if (open) {
          open.count += 1;
          return Promise.resolve([
            {
              id: open.id,
              opened: false,
              notified_at: open.notified ? new Date() : null,
            },
          ]);
        }
        const row = {
          id: `o${outages.length + 1}`,
          unit,
          ended: false,
          count: 1,
          notified: false,
        };
        outages.push(row);
        return Promise.resolve([
          { id: row.id, opened: true, notified_at: null },
        ]);
      }
      if (sql.includes('SET notified_at')) {
        const row = outages.find((o) => o.id === params[0] && !o.notified);
        if (row) row.notified = true;
        return Promise.resolve([row ? [{ id: row.id }] : [], row ? 1 : 0]);
      }
      if (sql.includes('SET ended_at')) {
        const closed = outages.filter((o) => o.unit === params[0] && !o.ended);
        closed.forEach((o) => (o.ended = true));
        return Promise.resolve([
          closed.map((o) => ({ id: o.id })),
          closed.length,
        ]);
      }
      return Promise.resolve([]);
    }),
  };
  const notify = {
    notifyAdmins: jest.fn(() => Promise.resolve()),
    statusChanged: jest.fn(),
  };
  const service = new TseOutageService(repository as never, notify as never);
  return { service, outages, notify, repository };
}

describe('TseOutageService', () => {
  it('opens one outage per TSE, counts failures and notifies admins once', async () => {
    const { service, outages, notify } = setup();
    await service.recordFailure('org', 'unit', 'E_TIMEOUT', 'no response');
    await service.recordFailure('org', 'unit', 'E_TIMEOUT', 'no response');
    await service.recordFailure('org', 'unit', 'E_NETWORK', 'reset');
    expect(outages).toHaveLength(1);
    expect(outages[0].count).toBe(3);
    expect(notify.notifyAdmins).toHaveBeenCalledTimes(1);
    expect(notify.notifyAdmins).toHaveBeenCalledWith(
      'org',
      'outage',
      expect.any(Array),
    );
    expect(notify.statusChanged).toHaveBeenCalledWith('org', {
      state: 'error',
      outage: true,
      reason: 'E_TIMEOUT',
    });
  });

  it('closes the outage on the next success and skips the query afterwards', async () => {
    const { service, outages, notify, repository } = setup();
    await service.recordFailure('org', 'unit', 'E_TIMEOUT', 'x');
    await service.recordSuccess('org', 'unit');
    expect(outages[0].ended).toBe(true);
    expect(notify.statusChanged).toHaveBeenLastCalledWith('org', {
      state: 'ok',
      outage: false,
    });
    const calls = repository.query.mock.calls.length;
    await service.recordSuccess('org', 'unit');
    expect(repository.query.mock.calls.length).toBe(calls);
  });

  it('opens a new outage after a closed one', async () => {
    const { service, outages, notify } = setup();
    await service.recordFailure('org', 'unit', 'E_A', 'x');
    await service.recordSuccess('org', 'unit');
    await service.recordFailure('org', 'unit', 'E_B', 'y');
    expect(outages).toHaveLength(2);
    expect(notify.notifyAdmins).toHaveBeenCalledTimes(2);
  });
});
