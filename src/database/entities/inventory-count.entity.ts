import { Entity, Column, ManyToOne, OneToMany, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Event } from './event.entity';
import { User } from './user.entity';
import { InventoryCountItem } from './inventory-count-item.entity';

export enum InventoryCountStatus {
  DRAFT = 'draft',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

@Entity('inventory_counts')
@Index(['eventId'])
export class InventoryCount extends BaseEntity {
  @Column({ name: 'event_id', type: 'uuid' })
  eventId: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'enum', enum: InventoryCountStatus, enumName: 'inventory_count_status', default: InventoryCountStatus.DRAFT })
  status: InventoryCountStatus;

  @Column({ name: 'started_at', type: 'timestamp with time zone', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'completed_at', type: 'timestamp with time zone', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ name: 'created_by_user_id', type: 'uuid' })
  createdByUserId: string;

  @Column({ name: 'completed_by_user_id', type: 'uuid', nullable: true })
  completedByUserId: string | null;

  // Relations
  @ManyToOne(() => Event, (event) => event.inventoryCounts, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event: Event;

  @ManyToOne(() => User, (user) => user.createdInventoryCounts, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'created_by_user_id' })
  createdByUser: User;

  @ManyToOne(() => User, (user) => user.completedInventoryCounts, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'completed_by_user_id' })
  completedByUser: User | null;

  @OneToMany(() => InventoryCountItem, (item) => item.inventoryCount)
  items: InventoryCountItem[];
}
