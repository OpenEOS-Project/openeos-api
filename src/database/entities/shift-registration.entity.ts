import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Shift } from './shift.entity';

export enum ShiftRegistrationStatus {
  PENDING_EMAIL = 'pending_email',
  PENDING_APPROVAL = 'pending_approval',
  CONFIRMED = 'confirmed',
  REJECTED = 'rejected',
  CANCELLED = 'cancelled',
}

@Entity('shift_registrations')
@Index(['shiftId', 'status'])
@Index(['email'])
@Index(['verificationToken'], { unique: true })
@Index(['registrationGroupId'])
export class ShiftRegistration extends BaseEntity {
  @Column({ name: 'shift_id', type: 'uuid' })
  shiftId: string;

  // Group ID to link multiple registrations from same submission
  @Column({ name: 'registration_group_id', type: 'uuid' })
  registrationGroupId: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  phone: string | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({
    type: 'enum',
    enum: ShiftRegistrationStatus,
    enumName: 'shift_registration_status',
    default: ShiftRegistrationStatus.PENDING_EMAIL,
  })
  status: ShiftRegistrationStatus;

  @Column({ name: 'email_verified_at', type: 'timestamp with time zone', nullable: true })
  emailVerifiedAt: Date | null;

  @Column({ name: 'verification_token', type: 'varchar', length: 64 })
  verificationToken: string;

  @Column({ name: 'admin_notes', type: 'text', nullable: true })
  adminNotes: string | null;

  @Column({ name: 'reminder_sent_at', type: 'timestamp with time zone', nullable: true })
  reminderSentAt: Date | null;

  // Admin-initiated shift-move proposal. When set, the helper has been sent
  // an email with token-based accept/decline links pointing at this row;
  // accepting flips shiftId to proposedShiftId, declining clears the fields.
  @Column({ name: 'proposed_shift_id', type: 'uuid', nullable: true })
  proposedShiftId: string | null;

  @Column({ name: 'proposed_at', type: 'timestamp with time zone', nullable: true })
  proposedAt: Date | null;

  @Column({ name: 'proposed_message', type: 'text', nullable: true })
  proposedMessage: string | null;

  @Column({ name: 'proposed_token', type: 'varchar', length: 64, nullable: true })
  proposedToken: string | null;

  // Relations
  @ManyToOne(() => Shift, (shift) => shift.registrations, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'shift_id' })
  shift: Shift;

  @ManyToOne(() => Shift, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'proposed_shift_id' })
  proposedShift: Shift | null;

  // Helper methods
  isPending(): boolean {
    return (
      this.status === ShiftRegistrationStatus.PENDING_EMAIL ||
      this.status === ShiftRegistrationStatus.PENDING_APPROVAL
    );
  }

  isConfirmed(): boolean {
    return this.status === ShiftRegistrationStatus.CONFIRMED;
  }

  isEmailVerified(): boolean {
    return this.emailVerifiedAt !== null;
  }
}
