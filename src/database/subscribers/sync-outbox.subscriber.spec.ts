import { EntityManager, InsertEvent, UpdateEvent } from 'typeorm';
import { SyncOutboxSubscriber } from './sync-outbox.subscriber';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { Payment } from '../entities/payment.entity';
import { PrintJob } from '../entities/print-job.entity';

type SyncableEntity = Order | OrderItem | Payment | PrintJob;

describe('SyncOutboxSubscriber', () => {
  const originalRole = process.env.SYNC_ROLE;
  const originalAssignmentId = process.env.SYNC_ASSIGNMENT_ID;
  let subscriber: SyncOutboxSubscriber;
  let manager: { query: jest.Mock; insert: jest.Mock };

  function insertEvent(entity: object): InsertEvent<SyncableEntity> {
    return {
      entity,
      manager: manager as unknown as EntityManager,
      metadata: { target: Order, tableName: 'orders' },
    } as unknown as InsertEvent<SyncableEntity>;
  }

  function updateEvent(
    entity: object | undefined,
  ): UpdateEvent<SyncableEntity> {
    return {
      entity,
      manager: manager as unknown as EntityManager,
      metadata: { target: Order, tableName: 'orders' },
    } as unknown as UpdateEvent<SyncableEntity>;
  }

  beforeEach(() => {
    subscriber = new SyncOutboxSubscriber();
    manager = {
      query: jest.fn().mockResolvedValue([{ nextval: '42' }]),
      insert: jest.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    process.env.SYNC_ROLE = originalRole;
    process.env.SYNC_ASSIGNMENT_ID = originalAssignmentId;
  });

  describe('when SYNC_ROLE is not "box" (the default — a normal central deployment)', () => {
    beforeEach(() => {
      delete process.env.SYNC_ROLE;
    });

    it('does not stamp or queue on insert', async () => {
      const entity: Partial<Order> = {};
      await subscriber.beforeInsert(insertEvent(entity));
      await subscriber.afterInsert(insertEvent(entity));

      expect(entity.originNode).toBeUndefined();
      expect(manager.query).not.toHaveBeenCalled();
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('does not stamp or queue on update', async () => {
      const entity: Partial<Order> = {};
      await subscriber.beforeUpdate(updateEvent(entity));
      await subscriber.afterUpdate(updateEvent(entity));

      expect(entity.originNode).toBeUndefined();
      expect(manager.insert).not.toHaveBeenCalled();
    });
  });

  describe('when SYNC_ROLE=box', () => {
    beforeEach(() => {
      process.env.SYNC_ROLE = 'box';
      process.env.SYNC_ASSIGNMENT_ID = 'assignment-42';
    });

    it('stamps originNode/syncVersion before insert and enqueues the outbox row after', async () => {
      const entity: Partial<Order> = { id: 'order-1' };

      await subscriber.beforeInsert(insertEvent(entity));
      expect(entity.originNode).toBe('assignment-42');
      expect(entity.syncVersion).toBe('42');
      expect(entity.syncedAt).toBeNull();

      await subscriber.afterInsert(insertEvent(entity));
      expect(manager.insert).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          entityType: 'orders',
          entityId: 'order-1',
          syncVersion: '42',
        }),
      );
    });

    it('ignores entities that are not in the syncable set', async () => {
      const event = {
        entity: {},
        manager: manager as unknown as EntityManager,
        // OrderItem exists but this event claims a target that isn't in it —
        // simulate an unrelated entity (e.g. User) being saved.
        metadata: { target: class Unrelated {}, tableName: 'unrelated' },
      } as unknown as InsertEvent<SyncableEntity>;

      await subscriber.beforeInsert(event);
      expect(manager.query).not.toHaveBeenCalled();
    });

    it('does nothing on update when event.entity is undefined (a bare .update() call, not repository.save())', async () => {
      await subscriber.beforeUpdate(updateEvent(undefined));
      await subscriber.afterUpdate(updateEvent(undefined));

      expect(manager.query).not.toHaveBeenCalled();
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('skips enqueueing if the entity has no id (defensive — should not happen post-insert)', async () => {
      await subscriber.afterInsert(insertEvent({}));
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('recognizes every configured syncable entity type, not just Order', async () => {
      const event = insertEvent({ id: 'item-1' });
      event.metadata.target = OrderItem;
      event.metadata.tableName = 'order_items';

      await subscriber.beforeInsert(event);
      expect(manager.query).toHaveBeenCalled();
    });
  });
});
