import { Entity, Column, ManyToOne, OneToMany, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { ShiftPlan } from './shift-plan.entity';
import { Shift } from './shift.entity';

@Entity('shift_jobs')
@Index(['shiftPlanId', 'sortOrder'])
export class ShiftJob extends BaseEntity {
  @Column({ name: 'shift_plan_id', type: 'uuid' })
  shiftPlanId: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 7, nullable: true })
  color: string | null;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  // Relations
  @ManyToOne(() => ShiftPlan, (plan) => plan.jobs, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'shift_plan_id' })
  shiftPlan: ShiftPlan;

  @OneToMany(() => Shift, (shift) => shift.job)
  shifts: Shift[];
}
