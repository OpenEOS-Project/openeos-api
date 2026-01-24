import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { User } from './user.entity';
import { Organization } from './organization.entity';

export enum AdminAction {
  VIEW_ORGANIZATION = 'view_organization',
  IMPERSONATE_START = 'impersonate_start',
  IMPERSONATE_END = 'impersonate_end',
  CREDIT_ADJUSTMENT = 'credit_adjustment',
  EDIT_ORGANIZATION = 'edit_organization',
  DELETE_ORGANIZATION = 'delete_organization',
  EDIT_USER = 'edit_user',
  UNLOCK_USER = 'unlock_user',
  MARK_INVOICE_PAID = 'mark_invoice_paid',
  COMPLETE_PURCHASE = 'complete_purchase',
  SET_DISCOUNT = 'set_discount',
  REMOVE_DISCOUNT = 'remove_discount',
  CREATE_RENTAL_HARDWARE = 'create_rental_hardware',
  ASSIGN_RENTAL = 'assign_rental',
  RETURN_RENTAL = 'return_rental',
}

export interface AuditLogDetails {
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  [key: string]: unknown;
}

@Entity('admin_audit_logs')
@Index(['adminUserId', 'createdAt'])
@Index(['organizationId', 'createdAt'])
export class AdminAuditLog extends BaseEntity {
  @Column({ name: 'admin_user_id', type: 'uuid' })
  adminUserId: string;

  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  @Column({ type: 'enum', enum: AdminAction, enumName: 'admin_action' })
  action: AdminAction;

  @Column({ name: 'resource_type', type: 'varchar', length: 50 })
  resourceType: string;

  @Column({ name: 'resource_id', type: 'uuid', nullable: true })
  resourceId: string | null;

  @Column({ type: 'jsonb', default: {} })
  details: AuditLogDetails;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ name: 'ip_address', type: 'varchar', length: 45 })
  ipAddress: string;

  @Column({ name: 'user_agent', type: 'varchar', length: 500, nullable: true })
  userAgent: string | null;

  // Relations
  @ManyToOne(() => User, (user) => user.adminAuditLogs, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'admin_user_id' })
  adminUser: User;

  @ManyToOne(() => Organization, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization | null;
}
