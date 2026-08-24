import { Entity, Column, ManyToOne, JoinColumn, Index, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { RentalAssignment } from './rental-assignment.entity';

/**
 * Central-side idempotent receipt log for rows pushed from a box
 * (docs/design/offline-box-sync.md §5). Deliberately a staging table, not
 * a write into the live orders/order_items/payments/print_jobs tables:
 * materializing into those tables needs Device rows to be resolvable too
 * (an Order's createdByDeviceId points at a device that self-registered
 * against the box's *local* api and was never synced to central — see the
 * design doc's Open Questions). That's real follow-up work, not something
 * to paper over with an untested generic column-mapper here.
 *
 * Idempotency: the unique constraint below makes a retried/duplicate push
 * a no-op (ON CONFLICT DO NOTHING in SyncService), not a double-insert.
 */
@Entity('sync_inbox')
@Unique(['entityType', 'entityId', 'syncVersion'])
@Index(['assignmentId', 'receivedAt'])
export class SyncInbox extends BaseEntity {
  @Column({ name: 'assignment_id', type: 'uuid' })
  assignmentId: string;

  @Column({ name: 'entity_type', type: 'varchar', length: 100 })
  entityType: string;

  @Column({ name: 'entity_id', type: 'uuid' })
  entityId: string;

  @Column({ name: 'sync_version', type: 'bigint' })
  syncVersion: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ name: 'received_at', type: 'timestamp with time zone' })
  receivedAt: Date;

  // Relations
  @ManyToOne(() => RentalAssignment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assignment_id' })
  assignment: RentalAssignment;
}
