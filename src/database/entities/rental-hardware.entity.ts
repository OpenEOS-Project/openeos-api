import { Entity, Column, OneToMany, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { RentalAssignment } from './rental-assignment.entity';

export enum RentalHardwareType {
  PRINTER = 'printer',
  DISPLAY = 'display',
}

export enum RentalHardwareStatus {
  AVAILABLE = 'available',
  RENTED = 'rented',
  MAINTENANCE = 'maintenance',
  RETIRED = 'retired',
}

export interface RentalHardwareConfig {
  connectionType?: string;
  ipAddress?: string;
  port?: number;
  paperWidth?: string;
  agentId?: string;
  resolution?: string;
  size?: string;
  includesMount?: boolean;
  [key: string]: unknown;
}

@Entity('rental_hardware')
@Index(['serialNumber'], { unique: true })
@Index(['status'])
export class RentalHardware extends BaseEntity {
  @Column({ type: 'enum', enum: RentalHardwareType, enumName: 'rental_hardware_type' })
  type: RentalHardwareType;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ name: 'serial_number', type: 'varchar', length: 100, unique: true })
  serialNumber: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  model: string | null;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'daily_rate', type: 'decimal', precision: 10, scale: 2 })
  dailyRate: number;

  @Column({ type: 'enum', enum: RentalHardwareStatus, enumName: 'rental_hardware_status', default: RentalHardwareStatus.AVAILABLE })
  status: RentalHardwareStatus;

  @Column({ name: 'hardware_config', type: 'jsonb', default: {} })
  hardwareConfig: RentalHardwareConfig;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  // Relations
  @OneToMany(() => RentalAssignment, (assignment) => assignment.rentalHardware)
  assignments: RentalAssignment[];
}
