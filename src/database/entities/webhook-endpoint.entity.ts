import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';
import { User } from './user.entity';

export type WebhookDisabledReason = 'too_many_failures';
export type WebhookLastDeliveryStatus = 'succeeded' | 'failed';

/**
 * Ein Empfaenger fuer ausgehende Webhooks (AGB Ziffer 10.2).
 *
 * Das Signatur-Geheimnis muss die API zum Signieren lesen koennen — es
 * steht deshalb verschluesselt (`enc:v1:`, IntegrationKeyring) statt als
 * Hash in der Tabelle und erscheint im Klartext genau einmal, beim Anlegen
 * bzw. Erneuern. Nach dem Erneuern gilt das alte noch 24 Stunden mit
 * (`previous_secret_*`), damit der Empfaenger in Ruhe umstellen kann.
 */
@Entity('webhook_endpoints')
@Index(['organizationId'])
export class WebhookEndpoint extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization?: Organization;

  @Column({ type: 'varchar', length: 2048 })
  url: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description: string | null;

  @Column({ name: 'event_types', type: 'jsonb', default: () => "'[]'::jsonb" })
  eventTypes: string[];

  @Column({ type: 'boolean', default: true })
  active: boolean;

  /** „Gästedaten mitsenden“: Name, Telefon und Notizen der Gäste. */
  @Column({ name: 'include_guest_data', type: 'boolean', default: false })
  includeGuestData: boolean;

  /** „Testbestellungen mitsenden“ (Testmodus, Phase „Geplant“). */
  @Column({ name: 'include_test_orders', type: 'boolean', default: false })
  includeTestOrders: boolean;

  @Column({ name: 'secret_encrypted', type: 'text', select: false })
  secretEncrypted: string;

  /** Die ersten Zeichen des Geheimnisses, zum Wiedererkennen. */
  @Column({ name: 'secret_hint', type: 'varchar', length: 16 })
  secretHint: string;

  @Column({
    name: 'previous_secret_encrypted',
    type: 'text',
    nullable: true,
    select: false,
  })
  previousSecretEncrypted: string | null;

  @Column({
    name: 'previous_secret_expires_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  previousSecretExpiresAt: Date | null;

  /** Fehlgeschlagene Versuche seit dem letzten Erfolg. */
  @Column({ name: 'consecutive_failures', type: 'int', default: 0 })
  consecutiveFailures: number;

  @Column({
    name: 'failing_since',
    type: 'timestamp with time zone',
    nullable: true,
  })
  failingSince: Date | null;

  @Column({
    name: 'disabled_reason',
    type: 'varchar',
    length: 40,
    nullable: true,
  })
  disabledReason: WebhookDisabledReason | null;

  @Column({
    name: 'disabled_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  disabledAt: Date | null;

  @Column({
    name: 'last_delivery_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  lastDeliveryAt: Date | null;

  @Column({
    name: 'last_delivery_status',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  lastDeliveryStatus: WebhookLastDeliveryStatus | null;

  @Column({
    name: 'last_success_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  lastSuccessAt: Date | null;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'created_by_user_id' })
  createdBy?: User | null;
}
