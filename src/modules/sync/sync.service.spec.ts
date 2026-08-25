import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SyncService } from './sync.service';
import { SyncInbox } from '../../database/entities/sync-inbox.entity';
import { RentalAssignment } from '../../database/entities';

describe('SyncService', () => {
  let service: SyncService;
  let queryBuilder: {
    insert: jest.Mock;
    into: jest.Mock;
    values: jest.Mock;
    orIgnore: jest.Mock;
    execute: jest.Mock;
  };

  const assignment = { id: 'assignment-1' } as RentalAssignment;

  beforeEach(async () => {
    queryBuilder = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      execute: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncService,
        {
          provide: getRepositoryToken(SyncInbox),
          useValue: {
            createQueryBuilder: jest.fn(() => queryBuilder),
          },
        },
      ],
    }).compile();

    service = module.get(SyncService);
  });

  it('short-circuits on an empty batch without touching the database', async () => {
    const result = await service.ingest(assignment, { rows: [] });

    expect(result).toEqual({ received: 0, inserted: 0, duplicates: 0 });
    expect(queryBuilder.insert).not.toHaveBeenCalled();
  });

  it('reports every row inserted when none conflict', async () => {
    queryBuilder.execute.mockResolvedValue({
      identifiers: [{ id: 'a' }, { id: 'b' }],
    });

    const result = await service.ingest(assignment, {
      rows: [
        {
          entityType: 'orders',
          entityId: 'order-1',
          syncVersion: '1',
          payload: {},
        },
        {
          entityType: 'orders',
          entityId: 'order-2',
          syncVersion: '2',
          payload: {},
        },
      ],
    });

    expect(result).toEqual({ received: 2, inserted: 2, duplicates: 0 });
  });

  it('treats rows RETURNING skipped (ON CONFLICT DO NOTHING) as duplicates, not errors', async () => {
    // Postgres RETURNING only yields actually-inserted rows: 3 rows pushed,
    // 1 already present from a retried batch, so only 2 identifiers come back.
    queryBuilder.execute.mockResolvedValue({
      identifiers: [{ id: 'a' }, { id: 'b' }],
    });

    const result = await service.ingest(assignment, {
      rows: [
        {
          entityType: 'orders',
          entityId: 'order-1',
          syncVersion: '1',
          payload: {},
        },
        {
          entityType: 'orders',
          entityId: 'order-2',
          syncVersion: '2',
          payload: {},
        },
        {
          entityType: 'orders',
          entityId: 'order-1',
          syncVersion: '1',
          payload: {},
        }, // retried duplicate
      ],
    });

    expect(result).toEqual({ received: 3, inserted: 2, duplicates: 1 });
  });

  it('tags every inserted row with the pushing assignment id', async () => {
    queryBuilder.execute.mockResolvedValue({ identifiers: [{ id: 'a' }] });

    await service.ingest(assignment, {
      rows: [
        {
          entityType: 'orders',
          entityId: 'order-1',
          syncVersion: '1',
          payload: { foo: 'bar' },
        },
      ],
    });

    expect(queryBuilder.values).toHaveBeenCalledWith([
      expect.objectContaining({
        assignmentId: 'assignment-1',
        entityId: 'order-1',
        syncVersion: '1',
      }),
    ]);
  });
});
