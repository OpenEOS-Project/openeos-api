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
  // Kauf auf Rechnung ueber Stripe Invoicing
  EVENT_INVOICE_ISSUED = 'event_invoice_issued',
  EVENT_INVOICE_PAID = 'event_invoice_paid',
  EVENT_INVOICE_PAYMENT_FAILED = 'event_invoice_payment_failed',
  EVENT_INVOICE_VOIDED = 'event_invoice_voided',
  EVENT_INVOICE_UNCOLLECTIBLE = 'event_invoice_uncollectible',
  EVENT_INVOICE_CREDIT_NOTE = 'event_invoice_credit_note',
  EVENT_INVOICE_RESENT = 'event_invoice_resent',
  EVENT_INVOICE_MARKED_PAID = 'event_invoice_marked_paid',
  /** Support hat ohne vollstaendige Pflichtangaben erlassen (mit Grund). */
  EVENT_MASTER_DATA_OVERRIDE = 'event_master_data_override',
  /**
   * Support hat Beginn/Ende einer Veranstaltung nach Beginn des
   * Verkaufsfensters verschoben (mit Grund), Phasen 2026-11-08.
   */
  EVENT_DATES_OVERRIDE = 'event_dates_override',
  // Assistent-Funktionen (ki-plan.md Abschnitt 6)
  ASSISTANT_ENABLED = 'assistant_enabled',
  ASSISTANT_DISABLED = 'assistant_disabled',
  MENU_IMPORT_APPLIED = 'menu_import_applied',
  // API-Tokens je Organisation (ki-plan.md Abschnitt 8)
  API_TOKEN_CREATED = 'api_token_created',
  API_TOKEN_REVOKED = 'api_token_revoked',
  /** Schreibender Aufruf eines Agenten-Tools (MCP), ki-plan.md Abschnitt 9. */
  AGENT_TOOL_CALL = 'agent_tool_call',
  /** Betriebsart gewechselt (Admins des Vereins oder Support mit Grund). */
  SET_OPERATING_MODE = 'set_operating_mode',
  /** Land einer Organisation geaendert (nur Support, mit Grund). */
  SET_ORGANIZATION_COUNTRY = 'set_organization_country',
  /** @deprecated Bargeld-Regel der Zwischenloesung (2026-11-01); nur noch Altdaten. */
  SET_CASH_POLICY = 'set_cash_policy',
  // Cloud-TSE (tse-swissbit-plan.md §8)
  TSE_INTEGRATION_ENABLED = 'tse_integration_enabled',
  TSE_INTEGRATION_DISABLED = 'tse_integration_disabled',
  TSE_CREATION_REQUESTED = 'tse_creation_requested',
  TSE_ACTIVATED = 'tse_activated',
  TSE_CREATION_FAILED = 'tse_creation_failed',
  TSE_DEACTIVATED = 'tse_deactivated',
  TSE_EXPORT_REQUESTED = 'tse_export_requested',
  /** Monatsende: Abmeldung verschoben (bezahlte Veranstaltung laeuft), mit Kostenhinweis. */
  TSE_DEACTIVATION_POSTPONED = 'tse_deactivation_postponed',
  /** Monatsende: Abmeldung um 22:00 noch nicht gelungen, Betreiber gewarnt. */
  TSE_DEACTIVATION_OVERDUE = 'tse_deactivation_overdue',
  /** Monatsende: TSE bleibt, weil im Folgemonat schon eine bezahlte Veranstaltung gebucht ist. */
  TSE_KEPT_FOR_NEXT_MONTH = 'tse_kept_for_next_month',
  /** Behalten widerrufen (Veranstaltung im Folgemonat vor dem Monatswechsel storniert/erstattet). */
  TSE_KEEP_REVOKED = 'tse_keep_revoked',
  // DSFinV-K (openeos-api#102)
  DSFINVK_CLOSING_REQUESTED = 'dsfinvk_closing_requested',
  DSFINVK_EXPORTED = 'dsfinvk_exported',
  // Bedienungen (bedienungen-plan.md §11)
  WAITER_CREATED = 'waiter_created',
  WAITER_UPDATED = 'waiter_updated',
  WAITER_PIN_RESET = 'waiter_pin_reset',
  WAITER_DELETED = 'waiter_deleted',
  /** PIN-Eingabe eines Geraets nach 20 Fehlversuchen gesperrt (System). */
  WAITER_PIN_LOCK = 'waiter_pin_lock',
  WAITER_PIN_UNLOCK = 'waiter_pin_unlock',
  /** Kellnerabrechnung abgeschlossen (erzwungen: mit Notiz). */
  WAITER_SETTLED = 'waiter_settled',
  /** Offene Tische/Bestellungen an eine andere Bedienung uebergeben. */
  WAITER_TABLES_TRANSFERRED = 'waiter_tables_transferred',
  // Ausgehende Webhooks (AGB Ziffer 10.2)
  WEBHOOK_CREATED = 'webhook_created',
  WEBHOOK_UPDATED = 'webhook_updated',
  WEBHOOK_DELETED = 'webhook_deleted',
  WEBHOOK_SECRET_ROTATED = 'webhook_secret_rotated',
  /** Zu viele Fehlversuche in Folge — vom System abgeschaltet. */
  WEBHOOK_AUTO_DISABLED = 'webhook_auto_disabled',
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
