import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base.entity';

/**
 * Box-side pending-push queue (docs/design/offline-box-sync.md §5). Only
 * populated when SYNC_ROLE=box — see SyncOutboxSubscriber. A row here means
 * "this change hasn't been confirmed as received by central yet"; pushedAt
 * is set once SyncPushService gets a 2xx from POST /sync/push for it.
 */
@Entity('sync_outbox')
@Index(['pushedAt', 'syncVersion'])
export class SyncOutbox extends BaseEntity {
  @Column({ name: 'entity_type', type: 'varchar', length: 100 })
  entityType: string;

  @Column({ name: 'entity_id', type: 'uuid' })
  entityId: string;

  /** Same value as the source row's sync_version at write time. */
  @Column({ name: 'sync_version', type: 'bigint' })
  syncVersion: string;

  /** Full entity snapshot at write time, not a diff — see design doc §7 open questions. */
  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({
    name: 'pushed_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  pushedAt: Date | null;
}
