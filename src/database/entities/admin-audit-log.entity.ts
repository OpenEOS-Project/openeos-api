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
  /** @deprecated Vermietung entfernt (2026-10); bleibt fuer alte Eintraege. */
  CREATE_RENTAL_HARDWARE = 'create_rental_hardware',
  /** @deprecated Vermietung entfernt (2026-10); bleibt fuer alte Eintraege. */
  ASSIGN_RENTAL = 'assign_rental',
  /** @deprecated Vermietung entfernt (2026-10); bleibt fuer alte Eintraege. */
  RETURN_RENTAL = 'return_rental',
  // Freischaltung einer Veranstaltung (Stripe/Rechnung)
  EVENT_CHECKOUT_RELEASED = 'event_checkout_released',
  EVENT_BILLING_CANCELLED = 'event_billing_cancelled',
  EVENT_BILLING_GOODWILL_REFUND = 'event_billing_goodwill_refund',
  EVENT_PAYMENT_DISPUTE_OPENED = 'event_payment_dispute_opened',
  EVENT_PAYMENT_DISPUTE_CLOSED = 'event_payment_dispute_closed',
  EVENT_DUPLICATE_PAYMENT = 'event_duplicate_payment',
}

/**
 * Was das System ohne angemeldeten Admin protokolliert (Stripe-Webhooks,
 * Aufraeumjob), steht mit `admin_user_id = NULL` und dieser Adresse im
 * Protokoll.
 */
export const SYSTEM_AUDIT_IP = 'system';

export interface AuditLogDetails {
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  [key: string]: unknown;
}

@Entity('admin_audit_logs')
@Index(['adminUserId', 'createdAt'])
@Index(['organizationId', 'createdAt'])
export class AdminAuditLog extends BaseEntity {
  /** NULL: vom System ausgeloest (Webhook, zeitgesteuerter Job). */
  @Column({ name: 'admin_user_id', type: 'uuid', nullable: true })
  adminUserId: string | null;

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
  @ManyToOne(() => User, (user) => user.adminAuditLogs, {
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'admin_user_id' })
  adminUser: User | null;

  @ManyToOne(() => Organization, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization | null;
}
