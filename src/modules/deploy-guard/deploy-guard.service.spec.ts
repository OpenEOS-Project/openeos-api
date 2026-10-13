import { DeployGuardService } from './deploy-guard.service';

function serviceReturning(
  rows: { name: string; lastOrderAt: Date | string }[],
) {
  const qb: Record<string, jest.Mock> = {};
  for (const method of [
    'innerJoin',
    'select',
    'addSelect',
    'where',
    'andWhere',
    'groupBy',
    'addGroupBy',
    'orderBy',
  ]) {
    qb[method] = jest.fn(() => qb);
  }
  qb.getRawMany = jest.fn().mockResolvedValue(rows);
  const repo = { createQueryBuilder: jest.fn(() => qb) };
  return { service: new DeployGuardService(repo as never), qb };
}

describe('DeployGuardService', () => {
  const now = new Date('2026-10-14T18:00:00.000Z');

  it('is not busy without recent real orders', async () => {
    const { service } = serviceReturning([]);
    await expect(service.status(30, now)).resolves.toEqual({
      busy: false,
      windowMinutes: 30,
      checkedAt: '2026-10-14T18:00:00.000Z',
      events: [],
    });
  });

  it('is busy and names the events that sell', async () => {
    const { service } = serviceReturning([
      { name: 'Sommerfest', lastOrderAt: new Date('2026-10-14T17:58:00Z') },
      { name: 'Weinfest', lastOrderAt: '2026-10-14 17:40:00+00' },
    ]);
    const status = await service.status(30, now);

    expect(status.busy).toBe(true);
    expect(status.events).toEqual([
      { name: 'Sommerfest', lastOrderAt: '2026-10-14T17:58:00.000Z' },
      { name: 'Weinfest', lastOrderAt: '2026-10-14T17:40:00.000Z' },
    ]);
  });

  it('only counts orders inside the window', async () => {
    const { service, qb } = serviceReturning([]);
    await service.status(45, now);

    expect(qb.andWhere).toHaveBeenCalledWith('o.createdAt >= :since', {
      since: new Date('2026-10-14T17:15:00.000Z'),
    });
    expect(qb.andWhere).toHaveBeenCalledWith('o.isTest = false');
    expect(qb.where).toHaveBeenCalledWith('e.status = :status', {
      status: 'active',
    });
  });
});
