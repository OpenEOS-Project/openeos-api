import { Entity, Column, ManyToOne, OneToMany, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';
import { Event } from './event.entity';
import { ShiftJob } from './shift-job.entity';

export enum ShiftPlanStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
  CLOSED = 'closed',
}

export interface ShiftPlanSettings {
  requireApproval: boolean;
  allowMultipleShifts: boolean;
  reminderDaysBefore: number;
  maxShiftsPerPerson?: number;
}

@Entity('shift_plans')
@Index(['organizationId', 'createdAt'])
@Index(['publicSlug'], { unique: true })
@Index(['status'])
export class ShiftPlan extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'event_id', type: 'uuid', nullable: true })
  eventId: string | null;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'public_slug', type: 'varchar', length: 100 })
  publicSlug: string;

  @Column({
    type: 'enum',
    enum: ShiftPlanStatus,
    enumName: 'shift_plan_status',
    default: ShiftPlanStatus.DRAFT,
  })
  status: ShiftPlanStatus;

  @Column({ type: 'jsonb', default: { requireApproval: true, allowMultipleShifts: true, reminderDaysBefore: 1 } })
  settings: ShiftPlanSettings;

  // Relations
  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @ManyToOne(() => Event, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'event_id' })
  event: Event | null;

  @OneToMany(() => ShiftJob, (job) => job.shiftPlan)
  jobs: ShiftJob[];

  // Helper methods
  isPublished(): boolean {
    return this.status === ShiftPlanStatus.PUBLISHED;
  }

  isClosed(): boolean {
    return this.status === ShiftPlanStatus.CLOSED;
  }
}
