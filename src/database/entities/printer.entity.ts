import { Entity, Column, ManyToOne, OneToMany, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';
import { Device } from './device.entity';
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
@Index(['deviceId'])
export class Printer extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'enum', enum: PrinterType, enumName: 'printer_type' })
  type: PrinterType;

  @Column({ name: 'connection_type', type: 'enum', enum: PrinterConnectionType, enumName: 'printer_connection_type' })
  connectionType: PrinterConnectionType;

  @Column({ name: 'connection_config', type: 'jsonb', default: {} })
  connectionConfig: PrinterConnectionConfig;

  @Column({ name: 'device_id', type: 'uuid', nullable: true })
  deviceId: string | null;

  /** Stable local identifier from the agent's config.yaml. Used to match an
      agent-pushed printer back to an existing Printer row. */
  @Column({ name: 'agent_local_id', type: 'varchar', length: 64, nullable: true })
  agentLocalId: string | null;

  @Column({ name: 'paper_width', type: 'int', default: 80 })
  paperWidth: number;

  @Column({ name: 'has_cash_drawer', type: 'boolean', default: false })
  hasCashDrawer: boolean;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'is_online', type: 'boolean', default: false })
  isOnline: boolean;

  @Column({ name: 'last_seen_at', type: 'timestamp with time zone', nullable: true })
  lastSeenAt: Date | null;

  @Column({ name: 'rental_assignment_id', type: 'uuid', nullable: true })
  rentalAssignmentId: string | null;

  // Relations
  @ManyToOne(() => Organization, (org) => org.printers, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization | null;

  @ManyToOne(() => Device, (device) => device.printers, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'device_id' })
  device: Device | null;

  @OneToMany(() => PrintJob, (job) => job.printer)
  printJobs: PrintJob[];
}
