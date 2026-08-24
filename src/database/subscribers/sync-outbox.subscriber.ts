import {
  EventSubscriber,
  EntitySubscriberInterface,
  InsertEvent,
  UpdateEvent,
  EntityManager,
  EntityMetadata,
  QueryDeepPartialEntity,
} from 'typeorm';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { Payment } from '../entities/payment.entity';
import { PrintJob } from '../entities/print-job.entity';
import { SyncOutbox } from '../entities/sync-outbox.entity';

type SyncableEntity = Order | OrderItem | Payment | PrintJob;
type SyncableEntityCtor = new (...args: never[]) => SyncableEntity;

const SYNCABLE_ENTITIES = new Set<SyncableEntityCtor>([
  Order,
  OrderItem,
  Payment,
  PrintJob,
]);

/**
 * Transactional-outbox subscriber for offline box sync
 * (docs/design/offline-box-sync.md §5). Only active when SYNC_ROLE=box —
 * on a normal (central) deployment this is a complete no-op, so it adds
 * zero overhead to the production hot path.
 *
 * beforeInsert/beforeUpdate stamp originNode/syncVersion onto the entity
 * before it's written, so the persisted row itself carries them.
 * afterInsert/afterUpdate then write the outbox row from the now-fully-
 * persisted entity. Both pairs run inside the same transaction as the
 * triggering repository.save() call (TypeORM subscriber semantics), so the
 * business write and its outbox row commit or roll back together — the
 * outbox can never desync from the data it describes.
 *
 * This subscriber is entirely bypassed by the central-side ingest path
 * (SyncService writes to sync_inbox via a plain insert, not through
 * repository.save() on these entities), so replayed rows from a box never
 * get re-stamped or re-queued into another box's outbox.
 */
@EventSubscriber()
export class SyncOutboxSubscriber implements EntitySubscriberInterface<SyncableEntity> {
  private isBoxRole(): boolean {
    return process.env.SYNC_ROLE === 'box';
  }

  private isSyncable(
    target: EntityMetadata['target'],
  ): target is SyncableEntityCtor {
    return (
      typeof target === 'function' &&
      SYNCABLE_ENTITIES.has(target as SyncableEntityCtor)
    );
  }

  async beforeInsert(event: InsertEvent<SyncableEntity>): Promise<void> {
    if (!this.isBoxRole() || !this.isSyncable(event.metadata.target)) return;
    this.stamp(event.entity);
    await this.assignSyncVersion(event.entity, event.manager);
  }

  async beforeUpdate(event: UpdateEvent<SyncableEntity>): Promise<void> {
    if (
      !this.isBoxRole() ||
      !this.isSyncable(event.metadata.target) ||
      !event.entity
    )
      return;
    // UpdateEvent.entity is typed as ObjectLiteral by TypeORM (an update
    // can in principle be a partial object) — safe to treat as the full
    // entity here because every syncable-entity save in this codebase goes
    // through repository.save() with a complete instance, never a bare
    // .update() partial (which doesn't fire subscriber hooks at all).
    const entity = event.entity as SyncableEntity;
    this.stamp(entity);
    await this.assignSyncVersion(entity, event.manager);
  }

  async afterInsert(event: InsertEvent<SyncableEntity>): Promise<void> {
    if (!this.isBoxRole() || !this.isSyncable(event.metadata.target)) return;
    await this.enqueue(event.entity, event.metadata.tableName, event.manager);
  }

  async afterUpdate(event: UpdateEvent<SyncableEntity>): Promise<void> {
    if (
      !this.isBoxRole() ||
      !this.isSyncable(event.metadata.target) ||
      !event.entity
    )
      return;
    await this.enqueue(
      event.entity as SyncableEntity,
      event.metadata.tableName,
      event.manager,
    );
  }

  private stamp(entity: SyncableEntity): void {
    entity.originNode = process.env.SYNC_ASSIGNMENT_ID || 'box';
    entity.syncedAt = null;
  }

  private async assignSyncVersion(
    entity: SyncableEntity,
    manager: EntityManager,
  ): Promise<void> {
    const rows = await manager.query<{ nextval: string }[]>(
      `SELECT nextval('sync_version_seq') AS nextval`,
    );
    entity.syncVersion = rows[0].nextval;
  }

  private async enqueue(
    entity: SyncableEntity,
    tableName: string,
    manager: EntityManager,
  ): Promise<void> {
    if (!entity.id || entity.syncVersion == null) return;
    // Same QueryDeepPartialEntity/jsonb typing quirk as SyncService.ingest
    // — the payload column is intentionally opaque JSON, not a nested
    // entity graph.
    await manager.insert(SyncOutbox, {
      entityType: tableName,
      entityId: entity.id,
      syncVersion: entity.syncVersion,
      payload: entity,
    } as unknown as QueryDeepPartialEntity<SyncOutbox>);
  }
}
