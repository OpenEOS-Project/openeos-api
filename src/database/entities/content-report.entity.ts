import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Worum es in der Meldung geht (Auswahl im Formular). */
export const CONTENT_REPORT_REASONS = [
  'illegal',
  'intellectual_property',
  'personal_rights',
  'consumer_protection',
  'youth_protection',
  'fraud',
  'other',
] as const;
export type ContentReportReason = (typeof CONTENT_REPORT_REASONS)[number];

export const CONTENT_REPORT_STATUSES = ['open', 'in_review', 'closed'] as const;
export type ContentReportStatus = (typeof CONTENT_REPORT_STATUSES)[number];

/**
 * Massnahme nach der Pruefung:
 * - `none`: keine Massnahme (Inhalt bleibt),
 * - `hide_content`: einzelner Inhalt entfernt bzw. ausgeblendet (von Hand,
 *   z. B. Produkt oder Text — die Entscheidung wird hier festgehalten),
 * - `disable_shop`: Shop der Veranstaltung abgeschaltet bzw. Helferseite
 *   aus der Veroeffentlichung genommen (wird beim Speichern ausgefuehrt).
 */
export const CONTENT_REPORT_ACTIONS = [
  'none',
  'hide_content',
  'disable_shop',
] as const;
export type ContentReportAction = (typeof CONTENT_REPORT_ACTIONS)[number];

/** Welche oeffentliche Seite gemeldet wurde (aus der Fundstelle ermittelt). */
export type ContentReportTargetType = 'shop' | 'helper_page' | 'unknown';

/**
 * Meldung eines (moeglicherweise) rechtswidrigen Inhalts auf einer
 * oeffentlichen Seite, die Inhalte von Vereinen zeigt (Shop, Helferseiten)
 * — Melde- und Abhilfeverfahren nach Art. 16 DSA, Begruendung nach
 * Art. 17 DSA.
 *
 * Bewusst knapp: keine IP-Adresse, kein Browser. Geloescht wird
 * `RETENTION_CONTENT_REPORT_MONTHS` (12) Monate nach dem Abschluss.
 */
@Entity('content_reports')
@Index(['status', 'createdAt'])
@Index(['organizationId'])
export class ContentReport {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp with time zone' })
  updatedAt: Date;

  /** Fundstelle (URL) wie gemeldet. */
  @Column({ type: 'varchar', length: 1000 })
  url: string;

  @Column({ type: 'varchar', length: 40 })
  reason: ContentReportReason;

  @Column({ type: 'text' })
  description: string;

  @Column({ name: 'reporter_name', type: 'varchar', length: 200 })
  reporterName: string;

  @Column({ name: 'reporter_email', type: 'varchar', length: 255 })
  reporterEmail: string;

  /** Erklaerung, dass die Angaben nach bestem Wissen gemacht wurden. */
  @Column({ name: 'good_faith', type: 'boolean', default: false })
  goodFaith: boolean;

  @Column({ name: 'target_type', type: 'varchar', length: 20 })
  targetType: ContentReportTargetType;

  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  @Column({ name: 'event_id', type: 'uuid', nullable: true })
  eventId: string | null;

  @Column({ name: 'shift_plan_id', type: 'uuid', nullable: true })
  shiftPlanId: string | null;

  @Column({ type: 'varchar', length: 20, default: 'open' })
  status: ContentReportStatus;

  @Column({ type: 'varchar', length: 20, nullable: true })
  action: ContentReportAction | null;

  /** Kurzentscheidung („Inhalt rechtswidrig“, „kein Verstoss“ …). */
  @Column({ type: 'text', nullable: true })
  decision: string | null;

  /** Sachverhalt, auf den sich die Entscheidung stuetzt (Art. 17 Abs. 3 lit. b). */
  @Column({ type: 'text', nullable: true })
  facts: string | null;

  /** Rechtliche oder vertragliche Grundlage (Art. 17 Abs. 3 lit. d/e). */
  @Column({ type: 'text', nullable: true })
  ground: string | null;

  /** Rechtsbehelfe (Art. 17 Abs. 3 lit. f). */
  @Column({ type: 'text', nullable: true })
  redress: string | null;

  /** Wann die Massnahme ausgefuehrt wurde (nur `disable_shop`). */
  @Column({
    name: 'action_applied_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  actionAppliedAt: Date | null;

  /** Eingangsbestaetigung an den Meldenden (Art. 16 Abs. 4). */
  @Column({
    name: 'receipt_sent_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  receiptSentAt: Date | null;

  @Column({
    name: 'admin_notified_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  adminNotifiedAt: Date | null;

  @Column({
    name: 'reporter_notified_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  reporterNotifiedAt: Date | null;

  @Column({
    name: 'organization_notified_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  organizationNotifiedAt: Date | null;

  @Column({
    name: 'closed_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  closedAt: Date | null;

  @Column({ name: 'handled_by', type: 'uuid', nullable: true })
  handledBy: string | null;
}
