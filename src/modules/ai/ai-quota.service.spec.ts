import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { AiUsage } from '../../database/entities';
import { AiQuotaService } from './ai-quota.service';
import { AiProvider } from './ai-provider.interface';
import { berlinDayStart } from './berlin-day.util';

const ORG = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a11';

function setup(used: number, limits: Partial<Record<string, number>> = {}) {
  const where: Record<string, unknown>[] = [];
  const builder = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn(function (this: unknown, _sql: string, params: unknown) {
      where.push(params as Record<string, unknown>);
      return this;
    }),
    andWhere: jest.fn(function (this: unknown, _sql: string, params: unknown) {
      where.push(params as Record<string, unknown>);
      return this;
    }),
    getRawOne: jest.fn(() => Promise.resolve({ used: String(used) })),
  };
  const save = jest.fn((entity: Partial<AiUsage>) =>
    Promise.resolve({ ...entity, id: 'usage-1' }),
  );
  const update = jest.fn(() => Promise.resolve());
  const repository = {
    createQueryBuilder: jest.fn(() => builder),
    create: jest.fn((entity: Partial<AiUsage>) => entity),
    save,
    update,
  } as unknown as Repository<AiUsage>;
  const provider = {
    name: 'anthropic',
    modelFor: (purpose: string) =>
      purpose === 'extract' ? 'claude-sonnet-5-5' : 'claude-haiku-4-5',
  } as unknown as AiProvider;
  const configService = {
    get: () => ({
      provider: 'anthropic',
      menuImportsPerDay: 5,
      classifyPerDay: 500,
      ...limits,
    }),
  } as unknown as ConfigService;
  const service = new AiQuotaService(repository, provider, configService);
  return { service, save, update, where };
}

describe('AiQuotaService', () => {
  it('reports limit, used and remaining with the next Berlin midnight as reset', async () => {
    const { service, where } = setup(3);
    const now = new Date('2026-05-10T20:00:00Z'); // 22:00 CEST
    const quota = await service.getQuota(ORG, 'menu_import', now);
    expect(quota).toEqual({
      limit: 5,
      used: 3,
      remaining: 2,
      resetAt: '2026-05-10T22:00:00.000Z',
    });
    // counted from the start of the Berlin day
    expect(where).toContainEqual({ start: berlinDayStart(now) });
    expect(where).toContainEqual({ statuses: ['reserved', 'ok'] });
  });

  it('reserves a unit while the quota allows it', async () => {
    const { service, save } = setup(4);
    const usage = await service.reserve(ORG, 'user-1', 'menu_import');
    expect(usage.id).toBe('usage-1');
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        userId: 'user-1',
        feature: 'menu_import',
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        units: 1,
        status: 'reserved',
      }),
    );
  });

  it('rejects with 429 AI_QUOTA_EXCEEDED and resetAt once the day is used up', async () => {
    const { service, save } = setup(5);
    const now = new Date('2026-05-10T20:00:00Z');
    await expect(
      service.reserve(ORG, 'user-1', 'menu_import', 1, now),
    ).rejects.toMatchObject({
      status: 429,
      response: {
        code: 'AI_QUOTA_EXCEEDED',
        params: { limit: 5, used: 5, resetAt: '2026-05-10T22:00:00.000Z' },
      },
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('counts several classification units against the classify limit', async () => {
    const { service } = setup(498, { classifyPerDay: 500 });
    await expect(
      service.reserve(ORG, null, 'icon_suggest', 3),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      service.reserve(ORG, null, 'icon_suggest', 2),
    ).resolves.toMatchObject({ units: 2, model: 'claude-haiku-4-5' });
  });

  it('settles tokens and status after the call', async () => {
    const { service, update } = setup(0);
    await service.settle('usage-1', {
      status: 'ok',
      model: 'claude-sonnet-5-5',
      inputTokens: 1200,
      outputTokens: 300,
      durationMs: 4100,
    });
    expect(update).toHaveBeenCalledWith(
      { id: 'usage-1' },
      {
        status: 'ok',
        model: 'claude-sonnet-5-5',
        inputTokens: 1200,
        outputTokens: 300,
        durationMs: 4100,
      },
    );
  });
});
