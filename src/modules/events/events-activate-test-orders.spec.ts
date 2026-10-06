import { EntityManager, Repository } from 'typeorm';
import { Event, EventStatus } from '../../database/entities/event.entity';
import { User } from '../../database/entities';
import { DeploymentService } from '../../common/services/deployment.service';
import { GatewayService } from '../gateway/gateway.service';
import { EventsService } from './events.service';
import {
  TestOrderCleanupService,
  TestOrderPurgeResult,
} from './test-order-cleanup.service';

const ORG = '00000000-0000-4000-8000-000000000001';
const EVENT_ID = '00000000-0000-4000-8000-0000000000e1';

function purgeResult(
  overrides: Partial<TestOrderPurgeResult> = {},
): TestOrderPurgeResult {
  return {
    organizationId: ORG,
    eventId: EVENT_ID,
    deletedOrderIds: ['o1', 'o2'],
    deletedPfandReturns: 0,
    restockedProducts: [],
    ...overrides,
  };
}

/**
 * Aktivieren loescht die Testbuchungen — in derselben Transaktion wie der
 * Statuswechsel, Geraete werden erst nach dem Commit benachrichtigt.
 */
describe('EventsService.activate and test orders', () => {
  function build(options: {
    status?: EventStatus;
    billingEnabled?: boolean;
    billingStatus?: string;
    purge?: jest.Mock;
  }) {
    const event = {
      id: EVENT_ID,
      organizationId: ORG,
      name: 'Sommerfest',
      status: options.status ?? EventStatus.TEST,
      billingStatus: options.billingStatus ?? 'paid',
    } as unknown as Event;

    const log: string[] = [];
    const txRepository = {
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn((saved: Event) => {
        log.push(`save:${saved.status}`);
        return Promise.resolve(saved);
      }),
    };
    const manager = {
      query: jest.fn((sql: string) => {
        log.push(sql.includes('FOR UPDATE') ? 'lock' : 'query');
        return Promise.resolve([]);
      }),
      getRepository: jest.fn(() => txRepository),
    } as unknown as EntityManager;
    let committed = false;
    const eventRepository = {
      manager: {
        transaction: jest.fn(
          async (work: (m: EntityManager) => Promise<unknown>) => {
            const result = await work(manager);
            committed = true;
            log.push('commit');
            return result;
          },
        ),
      },
      save: jest.fn(),
    } as unknown as Repository<Event>;

    const cleanup = {
      purge:
        options.purge ??
        jest.fn(() => {
          log.push('purge');
          return Promise.resolve(purgeResult());
        }),
      notify: jest.fn(() => {
        log.push(`notify:${committed}`);
      }),
    } as unknown as TestOrderCleanupService & {
      purge: jest.Mock;
      notify: jest.Mock;
    };
    const gateway = {
      notifyEventStatusChanged: jest.fn(),
    } as unknown as GatewayService & { notifyEventStatusChanged: jest.Mock };

    const unused = {} as never;
    const service = new EventsService(
      eventRepository,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      gateway,
      {
        billingEnabled: options.billingEnabled ?? true,
      } as unknown as DeploymentService,
      cleanup,
    );
    jest
      .spyOn(
        service as unknown as {
          getEventAndCheckPermission: () => Promise<Event>;
        },
        'getEventAndCheckPermission',
      )
      .mockResolvedValue(event);

    return { service, event, cleanup, gateway, log, txRepository };
  }

  const user = { id: 'user-1' } as User;

  it('deletes test orders inside the activation transaction, notifies after commit', async () => {
    const { service, cleanup, log } = build({});

    const event = await service.activate(ORG, EVENT_ID, user);

    expect(event.status).toBe(EventStatus.ACTIVE);
    expect(cleanup.purge).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      EVENT_ID,
    );
    expect(log).toEqual([
      'lock',
      'purge',
      'save:active',
      'commit',
      'notify:true',
    ]);
    expect(cleanup.notify).toHaveBeenCalledWith(purgeResult());
  });

  it('also cleans up when activating an inactive event (test mode left earlier)', async () => {
    const { service, cleanup } = build({ status: EventStatus.INACTIVE });

    await service.activate(ORG, EVENT_ID, user);

    expect(cleanup.purge).toHaveBeenCalledTimes(1);
  });

  it('keeps the status and notifies nobody if deleting fails', async () => {
    const purge = jest.fn().mockRejectedValue(new Error('db down'));
    const { service, event, cleanup, gateway, txRepository } = build({
      purge,
    });

    await expect(service.activate(ORG, EVENT_ID, user)).rejects.toThrow(
      'db down',
    );

    expect(event.status).toBe(EventStatus.TEST);
    expect(txRepository.save).not.toHaveBeenCalled();
    expect(cleanup.notify).not.toHaveBeenCalled();
    expect(gateway.notifyEventStatusChanged).not.toHaveBeenCalled();
  });

  it('deletes nothing if the event may not be activated yet', async () => {
    const { service, cleanup } = build({ billingStatus: 'pending' });

    await expect(service.activate(ORG, EVENT_ID, user)).rejects.toBeDefined();

    expect(cleanup.purge).not.toHaveBeenCalled();
  });

  it('deletes nothing for an already active event', async () => {
    const { service, cleanup } = build({ status: EventStatus.ACTIVE });

    await expect(service.activate(ORG, EVENT_ID, user)).rejects.toBeDefined();

    expect(cleanup.purge).not.toHaveBeenCalled();
  });
});

describe('TestOrderCleanupService.notify', () => {
  function build() {
    const gateway = {
      notifyOrderUpdated: jest.fn(),
      notifyMenuRefresh: jest.fn(),
      notifyTablesUpdated: jest.fn(),
    };
    const service = new TestOrderCleanupService(
      gateway as unknown as GatewayService,
    );
    return { service, gateway };
  }

  it('tells tills and stations to reload', () => {
    const { service, gateway } = build();

    service.notify(purgeResult());

    expect(gateway.notifyOrderUpdated).toHaveBeenCalledTimes(2);
    expect(gateway.notifyOrderUpdated).toHaveBeenCalledWith(
      ORG,
      EVENT_ID,
      'o1',
      { deleted: true, reason: 'test-orders-deleted' },
    );
    expect(gateway.notifyMenuRefresh).toHaveBeenCalledWith(
      ORG,
      EVENT_ID,
      'event-settings',
    );
    expect(gateway.notifyTablesUpdated).toHaveBeenCalledWith(ORG);
  });

  it('stays quiet if there was nothing to delete', () => {
    const { service, gateway } = build();

    service.notify(purgeResult({ deletedOrderIds: [] }));

    expect(gateway.notifyOrderUpdated).not.toHaveBeenCalled();
    expect(gateway.notifyMenuRefresh).not.toHaveBeenCalled();
    expect(gateway.notifyTablesUpdated).not.toHaveBeenCalled();
  });
});
