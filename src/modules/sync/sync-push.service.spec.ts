import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SyncPushService } from './sync-push.service';
import { SyncOutbox } from '../../database/entities/sync-outbox.entity';

describe('SyncPushService', () => {
  let service: SyncPushService;
  let outboxRepo: { find: jest.Mock; update: jest.Mock };
  let config: Record<string, string>;
  let fetchMock: jest.MockedFunction<typeof fetch>;

  beforeEach(async () => {
    config = {
      'sync.role': 'box',
      'sync.centralUrl': 'https://central.example',
      'sync.token': 'tok',
    };
    outboxRepo = { find: jest.fn().mockResolvedValue([]), update: jest.fn() };
    fetchMock = jest.fn();
    global.fetch = fetchMock;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncPushService,
        { provide: getRepositoryToken(SyncOutbox), useValue: outboxRepo },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => config[key] },
        },
      ],
    }).compile();

    service = module.get(SyncPushService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does nothing when SYNC_ROLE is not "box"', async () => {
    config['sync.role'] = 'central';

    await service.handlePush();

    expect(outboxRepo.find).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing when there is nothing pending', async () => {
    await service.handlePush();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('warns and does not call fetch when central URL or token is unset', async () => {
    config['sync.centralUrl'] = '';
    outboxRepo.find.mockResolvedValue([
      {
        id: 'row-1',
        entityType: 'orders',
        entityId: 'o-1',
        syncVersion: '1',
        payload: {},
      },
    ]);

    await service.handlePush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(outboxRepo.update).not.toHaveBeenCalled();
  });

  it('pushes pending rows and marks them pushed on success', async () => {
    const rows = [
      {
        id: 'row-1',
        entityType: 'orders',
        entityId: 'o-1',
        syncVersion: '1',
        payload: { a: 1 },
      },
      {
        id: 'row-2',
        entityType: 'orders',
        entityId: 'o-2',
        syncVersion: '2',
        payload: { a: 2 },
      },
    ];
    outboxRepo.find.mockResolvedValue(rows);
    fetchMock.mockResolvedValue({ ok: true } as Response);

    await service.handlePush();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://central.example/sync/push',
      expect.objectContaining({
        method: 'POST',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- @types/jest types expect.objectContaining as any; nesting it is the standard Jest pattern
        headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
      }),
    );
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init!.body as string) as { rows: unknown[] };
    expect(body.rows).toHaveLength(2);
    expect(outboxRepo.update).toHaveBeenCalledWith(
      ['row-1', 'row-2'],
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- same expect.objectContaining/any nesting as above
      expect.objectContaining({ pushedAt: expect.any(Date) }),
    );
  });

  it('leaves rows unmarked when central rejects the push', async () => {
    outboxRepo.find.mockResolvedValue([
      {
        id: 'row-1',
        entityType: 'orders',
        entityId: 'o-1',
        syncVersion: '1',
        payload: {},
      },
    ]);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('unauthorized'),
    } as Response);

    await service.handlePush();

    expect(outboxRepo.update).not.toHaveBeenCalled();
  });

  it('does not let a second tick overlap a push still in flight', async () => {
    outboxRepo.find.mockResolvedValue([
      {
        id: 'row-1',
        entityType: 'orders',
        entityId: 'o-1',
        syncVersion: '1',
        payload: {},
      },
    ]);
    let resolveFetch!: (v: Response) => void;
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );

    const firstTick = service.handlePush();
    const secondTick = service.handlePush(); // should return immediately, no-op

    resolveFetch({ ok: true } as Response);
    await Promise.all([firstTick, secondTick]);

    expect(outboxRepo.find).toHaveBeenCalledTimes(1);
  });
});
