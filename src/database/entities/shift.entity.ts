import { Entity, Column, ManyToOne, OneToMany, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { ShiftJob } from './shift-job.entity';
import { ShiftRegistration } from './shift-registration.entity';

@Entity('shifts')
@Index(['shiftJobId', 'date'])
@Index(['date'])
export class Shift extends BaseEntity {
  @Column({ name: 'shift_job_id', type: 'uuid' })
  shiftJobId: string;

  @Column({ type: 'date' })
  date: Date;

  @Column({ name: 'start_time', type: 'time' })
  startTime: string;

  @Column({ name: 'end_time', type: 'time' })
  endTime: string;

  @Column({ name: 'required_workers', type: 'int', default: 1 })
  requiredWorkers: number;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  // Relations
  @ManyToOne(() => ShiftJob, (job) => job.shifts, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'shift_job_id' })
  job: ShiftJob;

  @OneToMany(() => ShiftRegistration, (reg) => reg.shift)
  registrations: ShiftRegistration[];

  // Helper: Count confirmed registrations
  getConfirmedCount(): number {
    if (!this.registrations) return 0;
    return this.registrations.filter((r) => r.status === 'confirmed').length;
  }

  // Helper: Check if shift is fully booked
  isFull(): boolean {
    return this.getConfirmedCount() >= this.requiredWorkers;
  }

  // Helper: Get available spots
  getAvailableSpots(): number {
    return Math.max(0, this.requiredWorkers - this.getConfirmedCount());
  }
}
