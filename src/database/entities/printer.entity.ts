import { Entity, Column, ManyToOne, OneToMany, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';
import { PrintJob } from './print-job.entity';

export enum PrinterType {
  RECEIPT = 'receipt',
  KITCHEN = 'kitchen',
  LABEL = 'label',
}

export enum PrinterConnectionType {
  NETWORK = 'network',
  USB = 'usb',
  BLUETOOTH = 'bluetooth',
}

export interface PrinterConnectionConfig {
  ipAddress?: string;
  port?: number;
  usbVendorId?: string;
  usbProductId?: string;
  bluetoothAddress?: string;
  [key: string]: unknown;
}

@Entity('printers')
@Index(['organizationId'])
export class Printer extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'enum', enum: PrinterType, enumName: 'printer_type' })
  type: PrinterType;

  @Column({ name: 'connection_type', type: 'enum', enum: PrinterConnectionType, enumName: 'printer_connection_type' })
  connectionType: PrinterConnectionType;

  @Column({ name: 'connection_config', type: 'jsonb', default: {} })
  connectionConfig: PrinterConnectionConfig;

  @Column({ name: 'agent_id', type: 'varchar', length: 255, nullable: true })
  agentId: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'is_online', type: 'boolean', default: false })
  isOnline: boolean;

  @Column({ name: 'last_seen_at', type: 'timestamp with time zone', nullable: true })
  lastSeenAt: Date | null;

  // Relations
  @ManyToOne(() => Organization, (org) => org.printers, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @OneToMany(() => PrintJob, (job) => job.printer)
  printJobs: PrintJob[];
}
