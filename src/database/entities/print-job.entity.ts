import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';
import { Printer } from './printer.entity';
import { PrintTemplate } from './print-template.entity';
import { Order } from './order.entity';
import { OrderItem } from './order-item.entity';

export enum PrintJobStatus {
  QUEUED = 'queued',
  PRINTING = 'printing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export interface PrintJobPayload {
  type: string;
  data: Record<string, unknown>;
  [key: string]: unknown;
}

@Entity('print_jobs')
@Index(['printerId', 'status'])
@Index(['organizationId'])
export class PrintJob extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'printer_id', type: 'uuid' })
  printerId: string;

  @Column({ name: 'template_id', type: 'uuid', nullable: true })
  templateId: string | null;

  @Column({ name: 'order_id', type: 'uuid', nullable: true })
  orderId: string | null;

  @Column({ name: 'order_item_id', type: 'uuid', nullable: true })
  orderItemId: string | null;

  @Column({ type: 'enum', enum: PrintJobStatus, enumName: 'print_job_status', default: PrintJobStatus.QUEUED })
  status: PrintJobStatus;

  @Column({ type: 'jsonb', default: {} })
  payload: PrintJobPayload;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'printed_at', type: 'timestamp with time zone', nullable: true })
  printedAt: Date | null;

  // Relations
  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @ManyToOne(() => Printer, (printer) => printer.printJobs, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'printer_id' })
  printer: Printer;

  @ManyToOne(() => PrintTemplate, (template) => template.printJobs, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'template_id' })
  template: PrintTemplate | null;

  @ManyToOne(() => Order, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'order_id' })
  order: Order | null;

  @ManyToOne(() => OrderItem, (item) => item.printJobs, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'order_item_id' })
  orderItem: OrderItem | null;
}
