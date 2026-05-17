import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';
import { ShiftPlan } from './shift-plan.entity';

export enum ShiftChangeProposalStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  DECLINED = 'declined',
  EXPIRED = 'expired',
}

/** A single staged operation inside a proposal. `add` references a target
 *  shift; `remove` references one of the helper's existing registration rows. */
export type ShiftChangeOp =
  | { type: 'add'; shiftId: string }
  | { type: 'remove'; registrationId: string };

/**
 * Admin-initiated multi-op change proposal for a helper's group.
 * The helper opens the token URL from the email and either accepts (applies
 * all ops atomically) or declines (no DB changes).
 */
@Entity('shift_change_proposals')
@Index(['token'], { unique: true })
@Index(['registrationGroupId', 'status'])
export class ShiftChangeProposal extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'shift_plan_id', type: 'uuid' })
  shiftPlanId: string;

  @Column({ name: 'registration_group_id', type: 'uuid' })
  registrationGroupId: string;

  @Column({ type: 'varchar', length: 64 })
  token: string;

  @Column({ type: 'jsonb' })
  ops: ShiftChangeOp[];

  @Column({ type: 'text', nullable: true })
  message: string | null;

  @Column({
    type: 'enum',
    enum: ShiftChangeProposalStatus,
    enumName: 'shift_change_proposal_status',
    default: ShiftChangeProposalStatus.PENDING,
  })
  status: ShiftChangeProposalStatus;

  @Column({ name: 'responded_at', type: 'timestamp with time zone', nullable: true })
  respondedAt: Date | null;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @ManyToOne(() => ShiftPlan, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'shift_plan_id' })
  shiftPlan: ShiftPlan;
}
