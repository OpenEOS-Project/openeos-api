import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';

/**
 * Zustand einer Cloud-TSE (tse-swissbit-plan.md §7/§8):
 * - `creating`: bei Swissbit angelegt bzw. in Anlage, Client noch nicht registriert
 * - `active`: signiert (genau ein Client `OEOS-<kurz-id>`)
 * - `failed`: Anlage gescheitert (es gibt keine nutzbare TSE)
 * - `deactivated`: endgueltig ausser Betrieb (Swissbit `disableSecureElement`)
 */
export const TSE_UNIT_STATES = [
  'creating',
  'active',
  'failed',
  'deactivated',
] as const;
export type TseUnitState = (typeof TSE_UNIT_STATES)[number];

/** Wer die Anlage ausgeloest hat (Kostenzuordnung). */
export type TseUnitTrigger = 'manual' | 'auto' | 'super_admin';

/**
 * Eine Cloud-TSE einer Organisation. Je Organisation hoechstens eine in
 * `creating`/`active` (Teilindex), abgeloeste bleiben fuer die
 * Aufbewahrung (10 Jahre) stehen.
 *
 * Das Access Token gibt Swissbit nur einmal heraus; es liegt
 * AES-256-GCM-verschluesselt in `access_token_enc` (TseCryptoService).
 */
@Entity('tse_units')
@Index('IDX_tse_units_org', ['organizationId', 'createdAt'])
export class TseUnit extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @ManyToOne(() => Organization, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'organization_id' })
  organization?: Organization;

  @Column({ type: 'varchar', length: 20, default: 'swissbit' })
  provider: string;

  @Column({ type: 'varchar', length: 20 })
  state: TseUnitState;

  @Column({
    name: 'serial_number',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  serialNumber: string | null;

  @Column({
    name: 'access_token_enc',
    type: 'text',
    nullable: true,
    select: false,
  })
  accessTokenEnc?: string | null;

  @Column({ name: 'creation_id', type: 'varchar', length: 100, nullable: true })
  creationId: string | null;

  @Column({ name: 'product_type', type: 'varchar', length: 40 })
  productType: string;

  /** TSE-Client = Seriennummer der Kasse (des Vereins), max. 30 Zeichen. */
  @Column({ name: 'client_id', type: 'varchar', length: 30 })
  clientId: string;

  @Column({
    name: 'client_registered_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  clientRegisteredAt: Date | null;

  @Column({ name: 'public_key', type: 'text', nullable: true })
  publicKey: string | null;

  @Column({
    name: 'signature_algorithm',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  signatureAlgorithm: string | null;

  @Column({
    name: 'log_time_format',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  logTimeFormat: string | null;

  /** Zertifikat der TSE (Base64, DER) fuer die DSFinV-K (Stamm_TSE). */
  @Column({ type: 'text', nullable: true })
  certificate: string | null;

  @Column({
    name: 'certification_id',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  certificationId: string | null;

  @Column({
    name: 'certificate_expires_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  certificateExpiresAt: Date | null;

  @Column({ type: 'varchar', length: 20 })
  trigger: TseUnitTrigger;

  /** Bezahlte Veranstaltung, die die Anlage gerechtfertigt hat. */
  @Column({ name: 'trigger_event_id', type: 'uuid', nullable: true })
  triggerEventId: string | null;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId: string | null;

  /** Begruendung, wenn der Support die Bedingungen uebergangen hat. */
  @Column({ name: 'override_reason', type: 'text', nullable: true })
  overrideReason: string | null;

  @Column({
    name: 'activated_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  activatedAt: Date | null;

  @Column({
    name: 'failed_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  failedAt: Date | null;

  @Column({
    name: 'deactivated_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  deactivatedAt: Date | null;

  @Column({ name: 'deactivated_by_user_id', type: 'uuid', nullable: true })
  deactivatedByUserId: string | null;

  @Column({ name: 'deactivation_reason', type: 'text', nullable: true })
  deactivationReason: string | null;

  @Column({
    name: 'last_error_code',
    type: 'varchar',
    length: 60,
    nullable: true,
  })
  lastErrorCode: string | null;

  @Column({
    name: 'last_error_message',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  lastErrorMessage: string | null;

  @Column({
    name: 'last_error_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  lastErrorAt: Date | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  /**
   * Lebenszyklus `monthly`: geplante Abmeldung (letzter Tag des Monats,
   * 20:00 Berlin). Verschiebt sich um einen Monat, wenn zu diesem Zeitpunkt
   * eine bezahlte Veranstaltung laeuft (`metadata.postponements`).
   */
  @Column({
    name: 'planned_deactivation_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  plannedDeactivationAt: Date | null;

  /** Gescheiterte Abmeldeversuche im aktuellen Monatslauf. */
  @Column({ name: 'deactivation_attempts', type: 'int', default: 0 })
  deactivationAttempts: number;

  /** Naechster Abmeldeversuch nach einem Fehler (Backoff). */
  @Column({
    name: 'deactivation_next_attempt_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  deactivationNextAttemptAt: Date | null;

  /** Wann der Betreiber wegen ueberfaelliger Abmeldung gewarnt wurde. */
  @Column({
    name: 'deactivation_alerted_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  deactivationAlertedAt: Date | null;

  /** Kurzzeit-Sperre fuer Hintergrundschritte (mehrere API-Instanzen). */
  @Column({
    name: 'job_locked_until',
    type: 'timestamp with time zone',
    nullable: true,
  })
  jobLockedUntil: Date | null;

  @Column({ type: 'jsonb', default: {} })
  metadata: Record<string, unknown>;
}
