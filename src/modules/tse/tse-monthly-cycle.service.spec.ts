import { Logger, ServiceUnavailableException } from '@nestjs/common';

import { AdminAction } from '../../database/entities/admin-audit-log.entity';
import type { TseUnit } from '../../database/entities/tse-unit.entity';
import { berlinTime } from './tse-dates';
import { TseMonthlyCycleService } from './tse-monthly-cycle.service';
import type { PaidEventSpan } from './tse-monthly';

beforeAll(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});

const PLANNED = berlinTime(2026, 11, 30, 20);

function setup(
  options: {
    events?: PaidEventSpan[];
    exportDone?: boolean;
    lifecycle?: 'monthly' | 'persistent';
    unit?: Partial<TseUnit>;
  } = {},
) {
  const unit = {
    id: 'unit-1',
    organizationId: 'org-1',
    state: 'active',
    serialNumber: 'ff00',
    accessTokenEnc: 'enc:t',
    plannedDeactivationAt: PLANNED,
    deactivationAttempts: 0,
    deactivationNextAttemptAt: null,
    metadata: {},
    ...options.unit,
  } as TseUnit;
  const updates: Array<Partial<TseUnit>> = [];
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const unitRepository = {
    query: jest.fn((text: string, params: unknown[]) => {
      queries.push({ text, params });
      if (text.includes('SET job_locked_until = now()')) {
        return Promise.resolve([[{ id: unit.id }], 1]);
      }
      return Promise.resolve([[], 0]);
    }),
    update: jest.fn((_id: string, patch: Partial<TseUnit>) => {
      updates.push(patch);
      return Promise.resolve();
    }),
    find: jest.fn(() => Promise.resolve([])),
    createQueryBuilder: jest.fn(() => {
      const qb: Record<string, unknown> = {};
      for (const m of ['addSelect', 'where', 'andWhere', 'orderBy'])
        qb[m] = jest.fn(() => qb);
      qb.getMany = jest.fn(() => Promise.resolve([unit]));
      return qb;
    }),
  };
  let exportDone = options.exportDone ?? true;
  const exportRepository = {
    count: jest.fn(() => Promise.resolve(exportDone ? 1 : 0)),
  };
  const units = {
    paidEventsAround: jest.fn(() => Promise.resolve(options.events ?? [])),
    deactivate: jest.fn(() => Promise.resolve(unit)),
    audit: jest.fn(() => Promise.resolve()),
  };
  const exports = { collect: jest.fn(() => Promise.resolve([])) };
  const notify = { notifyPlatformAdmins: jest.fn(() => Promise.resolve(true)) };
  const service = new TseMonthlyCycleService(
    unitRepository as never,
    exportRepository as never,
    {} as never,
    {
      enabled: true,
      lifecycle: options.lifecycle ?? 'monthly',
    } as never,
    units as never,
    exports as never,
    notify as never,
    {
      runExclusive: jest.fn((_n: string, job: () => Promise<void>) => job()),
    } as never,
    { get: jest.fn(() => null) } as never,
  );
  service.retryDelaysMs = [0, 0];
  return {
    service,
    unit,
    units,
    exports,
    notify,
    updates,
    queries,
    setExportDone: (v: boolean) => (exportDone = v),
  };
}

const ev = (id: string, start: Date, end: Date | null): PaidEventSpan => ({
  id,
  name: id,
  startDate: start,
  endDate: end,
});

describe('TseMonthlyCycleService', () => {
  it('does nothing with TSE_LIFECYCLE=persistent', async () => {
    const f = setup({ lifecycle: 'persistent' });
    await f.service.cycleJob();
    expect(f.units.deactivate).not.toHaveBeenCalled();
    expect(f.service.active).toBe(false);
  });

  it('runs the final export in the preparation window (18:00) without deactivating', async () => {
    const f = setup({ exportDone: false });
    const outcome = await f.service.processUnit(
      f.unit,
      berlinTime(2026, 11, 30, 18),
    );
    expect(outcome).toBe('prepared');
    expect(f.exports.collect).toHaveBeenCalledWith(
      f.unit,
      expect.objectContaining({ startNew: true, trigger: 'final' }),
    );
    expect(f.units.deactivate).not.toHaveBeenCalled();
  });

  it('deactivates at 20:00 with reason monthly_cycle and keeps the integration on', async () => {
    const f = setup();
    const outcome = await f.service.processUnit(f.unit, PLANNED);
    expect(outcome).toBe('deactivated');
    expect(f.units.deactivate).toHaveBeenCalledWith(f.unit, {
      reason: 'monthly_cycle',
      userId: null,
      disableIntegration: false,
    });
  });

  it('postpones when a paid event runs at the planned time (event on the last day past midnight)', async () => {
    const f = setup({
      events: [
        ev('party', berlinTime(2026, 11, 30, 18), berlinTime(2026, 12, 1, 2)),
      ],
    });
    const outcome = await f.service.processUnit(
      f.unit,
      berlinTime(2026, 11, 30, 18),
    );
    expect(outcome).toBe('postponed');
    expect(f.units.deactivate).not.toHaveBeenCalled();
    const update = f.queries.find((q) =>
      q.text.includes('planned_deactivation_at = $2'),
    );
    expect((update?.params[1] as Date).toISOString()).toBe(
      '2026-12-31T19:00:00.000Z',
    );
    expect(f.units.audit).toHaveBeenCalledWith(
      AdminAction.TSE_DEACTIVATION_POSTPONED,
      'org-1',
      'unit-1',
      expect.objectContaining({
        details: expect.objectContaining({
          extraMonth: '2026-12',
          costNote: expect.stringContaining('weiteren Monat') as unknown,
        }) as unknown,
      }),
    );
  });

  it('does not postpone for an event in the middle of the month', async () => {
    const f = setup({
      events: [
        ev('mid', berlinTime(2026, 11, 14, 14), berlinTime(2026, 11, 15, 2)),
      ],
    });
    expect(await f.service.processUnit(f.unit, PLANNED)).toBe('deactivated');
  });

  it('waits for the final export until 21:00, then deactivates anyway', async () => {
    const f = setup({ exportDone: false });
    expect(
      await f.service.processUnit(f.unit, berlinTime(2026, 11, 30, 20, 30)),
    ).toBe('waiting_for_export');
    expect(
      await f.service.processUnit(f.unit, berlinTime(2026, 11, 30, 21)),
    ).toBe('deactivated');
  });

  it('records a failed attempt with backoff and the Swissbit error code', async () => {
    const f = setup();
    f.units.deactivate.mockRejectedValue(
      new ServiceUnavailableException({
        code: 'TSE_PROVIDER_ERROR',
        message: 'down',
        params: { requestId: 'r', errorCode: 'E_MAINTENANCE_IN_PROGRESS' },
      }),
    );
    const outcome = await f.service.processUnit(f.unit, PLANNED);
    expect(outcome).toBe('failed');
    expect(f.units.deactivate).toHaveBeenCalledTimes(3);
    expect(f.updates[0]).toMatchObject({
      deactivationAttempts: 1,
      lastErrorCode: 'E_MAINTENANCE_IN_PROGRESS',
      deactivationNextAttemptAt: new Date(PLANNED.getTime() + 5 * 60_000),
    });
  });

  it('respects the backoff before the next attempt', async () => {
    const f = setup({
      unit: {
        deactivationAttempts: 2,
        deactivationNextAttemptAt: new Date(PLANNED.getTime() + 10 * 60_000),
      },
    });
    expect(
      await f.service.processUnit(f.unit, new Date(PLANNED.getTime() + 60_000)),
    ).toBe('backoff');
    expect(f.units.deactivate).not.toHaveBeenCalled();
  });

  it('is idle outside the window', async () => {
    const f = setup();
    expect(
      await f.service.processUnit(f.unit, berlinTime(2026, 11, 30, 17, 59)),
    ).toBe('idle');
  });
});
