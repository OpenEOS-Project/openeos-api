import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { WebhookEndpoint } from './webhook-endpoint.entity';

export const WEBHOOK_DELIVERY_STATUSES = [
  'pending',
  'delivering',
  'succeeded',
  'failed',
] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/** Warum ein Versuch nicht geklappt hat — ohne Inhalte, nur die Art. */
export const WEBHOOK_DELIVERY_ERRORS = [
  'TIMEOUT',
  'CONNECTION_FAILED',
  'DNS_FAILED',
  'TLS_FAILED',
  'BLOCKED_ADDRESS',
  'REDIRECT_NOT_FOLLOWED',
  'HTTP_ERROR',
  'ENDPOINT_INACTIVE',
  'ENDPOINT_DELETED',
  'INTERNAL',
] as const;
export type WebhookDeliveryError = (typeof WEBHOOK_DELIVERY_ERRORS)[number];

export interface WebhookAttemptLogEntry {
  at: string;
  responseStatus: number | null;
  durationMs: number | null;
  error: WebhookDeliveryError | null;
}

/**
 * Eine Zustellung eines Ereignisses an einen Endpunkt, mit allen
 * Versuchen. `payload` ist genau der Text, der gesendet wird (bei jedem
 * Versuch und beim erneuten Senden derselbe, mit derselben `event_id`).
 * Kein Geheimnis und keine Signatur im Protokoll; von der Antwort nur die
 * ersten 1 024 Zeichen. Nach 30 Tagen geloescht (Aufbewahrung).
 */
@Entity('webhook_deliveries')
@Index(['endpointId', 'createdAt'])
export class WebhookDelivery extends BaseEntity {
  @Column({ name: 'endpoint_id', type: 'uuid' })
  endpointId: string;

  @ManyToOne(() => WebhookEndpoint, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'endpoint_id' })
  endpoint?: WebhookEndpoint;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId: string;

  @Column({ name: 'event_type', type: 'varchar', length: 60 })
  eventType: string;

  /** Der gesendete Text, Byte fuer Byte (die Signatur gilt genau fuer ihn). */
  @Column({ type: 'text' })
  payload: string;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: WebhookDeliveryStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({
    name: 'next_attempt_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  nextAttemptAt: Date | null;

  @Column({
    name: 'locked_until',
    type: 'timestamp with time zone',
    nullable: true,
  })
  lockedUntil: Date | null;

  @Column({
    name: 'last_attempt_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  lastAttemptAt: Date | null;

  @Column({ name: 'response_status', type: 'int', nullable: true })
  responseStatus: number | null;

  @Column({ name: 'response_body', type: 'text', nullable: true })
  responseBody: string | null;

  @Column({ name: 'duration_ms', type: 'int', nullable: true })
  durationMs: number | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  error: WebhookDeliveryError | null;

  @Column({
    name: 'attempt_log',
    type: 'jsonb',
    default: () => "'[]'::jsonb",
  })
  attemptLog: WebhookAttemptLogEntry[];

  /** „Test senden“ oder „Erneut senden“. */
  @Column({ type: 'boolean', default: false })
  manual: boolean;

  @Column({ name: 'redelivery_of', type: 'uuid', nullable: true })
  redeliveryOf: string | null;
}
