import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type RetentionNoticeSubject = 'organization' | 'user';

/**
 * - `organization_inactivity`: lange keine Buchung, Schliessung angekuendigt
 * - `organization_deletion`: Organisation geloescht bzw. geschlossen,
 *   endgueltige Loeschung angekuendigt
 * - `user_inactivity`: Konto ohne Organisation und ohne Anmeldung,
 *   Loeschung angekuendigt
 * - `account_deletion`: Benutzer hat sein Konto geloescht und war einziges
 *   Mitglied einer Organisation; das Konto wird mit ihr endgueltig
 *   geloescht (`details.organizationIds`)
 */
export type RetentionNoticeKind =
  | 'organization_inactivity'
  | 'organization_deletion'
  | 'user_inactivity'
  | 'account_deletion';

/**
 * Ankuendigung vor einer Schliessung oder endgueltigen Loeschung. Ohne
 * eine mindestens 30 Tage alte Ankuendigung (mit Exportangebot) loescht
 * kein Lauf eine Organisation oder ein Konto.
 */
@Entity('retention_notices')
@Index(['subjectType', 'subjectId'])
export class RetentionNotice {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'subject_type', type: 'varchar', length: 20 })
  subjectType: RetentionNoticeSubject;

  @Column({ name: 'subject_id', type: 'uuid' })
  subjectId: string;

  @Column({ type: 'varchar', length: 40 })
  kind: RetentionNoticeKind;

  @Column({ name: 'sent_at', type: 'timestamp with time zone' })
  sentAt: Date;

  @Column({ name: 'recipient_count', type: 'int', default: 0 })
  recipientCount: number;

  /** Frueheste Ausfuehrung (Schliessung bzw. Loeschung). */
  @Column({ name: 'due_at', type: 'timestamp with time zone' })
  dueAt: Date;

  /** Letzte Nutzung bei der Ankuendigung; spaetere Nutzung hebt sie auf. */
  @Column({
    name: 'activity_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  activityAt: Date | null;

  @Column({
    name: 'executed_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  executedAt: Date | null;

  @Column({
    name: 'cancelled_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  cancelledAt: Date | null;

  /** activity | restored | kept | … */
  @Column({
    name: 'cancel_reason',
    type: 'varchar',
    length: 40,
    nullable: true,
  })
  cancelReason: string | null;

  /**
   * Zuletzt verschickte Erinnerung: Tage vor `dueAt` (30, 10 oder 1). Jede
   * Erinnerung geht hoechstens einmal raus.
   */
  @Column({ name: 'reminder_days', type: 'int', nullable: true })
  reminderDays: number | null;

  @Column({
    name: 'reminded_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  remindedAt: Date | null;

  /** Zusatzangaben ohne Inhalte, z. B. `{ organizationIds: [...] }`. */
  @Column({ type: 'jsonb', nullable: true })
  details: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt: Date;
}
