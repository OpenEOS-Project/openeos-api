import { Entity, Column, ManyToOne, OneToMany, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';
import { PrintJob } from './print-job.entity';

export enum PrintTemplateType {
  RECEIPT = 'receipt',
  KITCHEN_TICKET = 'kitchen_ticket',
  ORDER_TICKET = 'order_ticket',
}

export interface PrintTemplateDefinition {
  width?: number;
  fontSize?: number;
  sections?: {
    type: string;
    content?: string;
    style?: Record<string, unknown>;
  }[];
  [key: string]: unknown;
}

@Entity('print_templates')
@Index(['organizationId'])
export class PrintTemplate extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'enum', enum: PrintTemplateType, enumName: 'print_template_type' })
  type: PrintTemplateType;

  @Column({ type: 'jsonb', default: {} })
  template: PrintTemplateDefinition;

  @Column({ name: 'is_default', type: 'boolean', default: false })
  isDefault: boolean;

  // Relations
  @ManyToOne(() => Organization, (org) => org.printTemplates, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @OneToMany(() => PrintJob, (job) => job.template)
  printJobs: PrintJob[];
}
