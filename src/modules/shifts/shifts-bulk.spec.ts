import { Shift } from '../../database/entities';
import { ShiftsService } from './shifts.service';

/**
 * `createShiftsBulk` (REST und Agenten-Werkzeug `create_shifts`) schreibt
 * alle Schichten in einer Transaktion — scheitert eine, bleibt keine halbe
 * Serie stehen.
 */
describe('ShiftsService.createShiftsBulk', () => {
  function setup(failAt?: number) {
    const committed: Record<string, unknown>[] = [];
    const transaction = jest.fn(
      async (work: (manager: unknown) => Promise<unknown>) => {
        const staged: Record<string, unknown>[] = [];
        const manager = {
          getRepository: (entity: unknown) => {
            if (entity !== Shift) throw new Error('unexpected repository');
            return {
              save: (rows: Record<string, unknown>[]) => {
                rows.forEach((row, i) => {
                  if (i === failAt) throw new Error('insert failed');
                  staged.push({ ...row, id: `s-${i}` });
                });
                return Promise.resolve(staged);
              },
            };
          },
        };
        const result = await work(manager);
        committed.push(...staged);
        return result;
      },
    );
    const shiftJobRepository = {
      findOne: () =>
        Promise.resolve({
          id: 'job-1',
          requiredWorkers: 3,
          shiftPlan: { organizationId: 'org-1' },
        }),
    };
    const shiftRepository = {
      create: (row: Record<string, unknown>) => ({ ...row }),
      manager: { transaction },
    };
    const none = {} as never;
    const service = new ShiftsService(
      none,
      shiftJobRepository as never,
      shiftRepository as never,
      none,
      none,
      none,
      none,
    );
    return { service, committed, transaction };
  }

  const dtos = [
    { date: '2026-07-10', startTime: '18:00', endTime: '22:00' },
    { date: '2026-07-11', startTime: '18:00', endTime: '22:00' },
  ];

  it('saves all shifts in one transaction with the job workers', async () => {
    const { service, committed, transaction } = setup();
    const created = await service.createShiftsBulk('org-1', 'job-1', dtos);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(2);
    expect(committed).toEqual([
      expect.objectContaining({ shiftJobId: 'job-1', requiredWorkers: 3 }),
      expect.objectContaining({ startTime: '18:00', endTime: '22:00' }),
    ]);
  });

  it('keeps nothing when one shift fails', async () => {
    const { service, committed } = setup(1);
    await expect(
      service.createShiftsBulk('org-1', 'job-1', dtos),
    ).rejects.toThrow('insert failed');
    expect(committed).toHaveLength(0);
  });
});
