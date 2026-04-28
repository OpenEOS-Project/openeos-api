import { Entity, Column, ManyToOne, OneToMany, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';
import { Order } from './order.entity';
import { Payment } from './payment.entity';
import { Printer } from './printer.entity';
import { User } from './user.entity';

export enum DeviceType {
  POS = 'pos',
  ADMIN = 'admin',
  PRINTER_AGENT = 'printer_agent',
}

export enum DeviceStatus {
  PENDING = 'pending',
  VERIFIED = 'verified',
  BLOCKED = 'blocked',
}

export type ServiceMode = 'table' | 'counter';
export type PrinterMode = 'device' | 'category' | 'product';

export interface DeviceSettings {
  defaultPrinterId?: string;
  soundEnabled?: boolean;
  autoLogout?: number;
  sumupReaderId?: string;
  serviceMode?: ServiceMode;
  printerMode?: PrinterMode;
  requirePin?: boolean;
  [key: string]: unknown;
}

@Entity('devices')
@Index(['organizationId'])
export class Device extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  @Column({ name: 'suggested_name', type: 'varchar', length: 255, nullable: true })
  suggestedName: string | null;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'enum', enum: DeviceType, enumName: 'device_type' })
  type: DeviceType;

  @Column({ name: 'device_token', type: 'varchar', length: 255, unique: true })
  deviceToken: string;

  @Column({ name: 'last_seen_at', type: 'timestamp with time zone', nullable: true })
  lastSeenAt: Date | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'enum', enum: DeviceStatus, enumName: 'device_status', default: DeviceStatus.PENDING })
  status: DeviceStatus;

  @Column({ name: 'verification_code', type: 'varchar', length: 6, nullable: true })
  verificationCode: string | null;

  @Column({ name: 'verified_at', type: 'timestamp with time zone', nullable: true })
  verifiedAt: Date | null;

  @Column({ name: 'verified_by_id', type: 'uuid', nullable: true })
  verifiedById: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 500, nullable: true })
  userAgent: string | null;

  @Column({ type: 'jsonb', default: {} })
  settings: DeviceSettings;

  // Relations
  @ManyToOne(() => Organization, (org) => org.devices, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'verified_by_id' })
  verifiedBy: User | null;

  @OneToMany(() => Order, (order) => order.createdByDevice)
  createdOrders: Order[];

  @OneToMany(() => Payment, (payment) => payment.processedByDevice)
  processedPayments: Payment[];

  @OneToMany(() => Printer, (printer) => printer.device)
  printers: Printer[];

  // Helper methods
  isOnline(): boolean {
    if (!this.lastSeenAt) return false;
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    return this.lastSeenAt > fiveMinutesAgo;
  }
}
