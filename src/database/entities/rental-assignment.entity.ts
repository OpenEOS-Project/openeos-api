import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { RentalHardware } from './rental-hardware.entity';
import { Organization } from './organization.entity';
import { Event } from './event.entity';
import { User } from './user.entity';
import { Invoice } from './invoice.entity';

export enum RentalAssignmentStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  ACTIVE = 'active',
  RETURNED = 'returned',
  CANCELLED = 'cancelled',
}

@Entity('rental_assignments')
@Index(['rentalHardwareId', 'status'])
@Index(['organizationId', 'startDate'])
@Index(['eventId'])
export class RentalAssignment extends BaseEntity {
  @Column({ name: 'rental_hardware_id', type: 'uuid' })
  rentalHardwareId: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'event_id', type: 'uuid', nullable: true })
  eventId: string | null;

  @Column({ type: 'enum', enum: RentalAssignmentStatus, enumName: 'rental_assignment_status', default: RentalAssignmentStatus.PENDING })
  status: RentalAssignmentStatus;

  @Column({ name: 'start_date', type: 'date' })
  startDate: Date;

  @Column({ name: 'end_date', type: 'date' })
  endDate: Date;

  @Column({ name: 'daily_rate', type: 'decimal', precision: 10, scale: 2 })
  dailyRate: number;

  @Column({ name: 'total_days', type: 'int' })
  totalDays: number;

  @Column({ name: 'total_amount', type: 'decimal', precision: 10, scale: 2 })
  totalAmount: number;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ name: 'assigned_by_user_id', type: 'uuid' })
  assignedByUserId: string;

  @Column({ name: 'confirmed_at', type: 'timestamp with time zone', nullable: true })
  confirmedAt: Date | null;

  @Column({ name: 'pickup_at', type: 'timestamp with time zone', nullable: true })
  pickupAt: Date | null;

  @Column({ name: 'returned_at', type: 'timestamp with time zone', nullable: true })
  returnedAt: Date | null;

  @Column({ name: 'invoice_id', type: 'uuid', nullable: true })
  invoiceId: string | null;

  // Relations
  @ManyToOne(() => RentalHardware, (hardware) => hardware.assignments, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'rental_hardware_id' })
  rentalHardware: RentalHardware;

  @ManyToOne(() => Organization, (org) => org.rentalAssignments, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @ManyToOne(() => Event, (event) => event.rentalAssignments, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'event_id' })
  event: Event | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'assigned_by_user_id' })
  assignedByUser: User;

  @ManyToOne(() => Invoice, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'invoice_id' })
  invoice: Invoice | null;
}
