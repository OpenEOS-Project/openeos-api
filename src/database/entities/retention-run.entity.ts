import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Protokoll der Loeschlaeufe: wann, welche Datenart, wie viele Datensaetze.
 * Bewusst ohne Inhalte — nur Zahlen, bei Einzelloeschungen zusaetzlich die
 * ausfuehrende Person und der Anlass. Keine Fremdschluessel: das Protokoll
 * muss die Organisation bzw. das Konto, um das es ging, ueberdauern.
 */
@Entity('retention_runs')
@Index(['category', 'startedAt'])
@Index(['startedAt'])
export class RetentionRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 40 })
  category: string;

  /** scheduled | manual | instruction */
  @Column({ type: 'varchar', length: 20 })
  trigger: string;

  @Column({ name: 'dry_run', type: 'boolean' })
  dryRun: boolean;

  /** running | succeeded | failed */
  @Column({ type: 'varchar', length: 20 })
  status: string;

  @Column({ name: 'started_at', type: 'timestamp with time zone' })
  startedAt: Date;

  @Column({
    name: 'finished_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  finishedAt: Date | null;

  /** Anzahl je Teilschritt, z. B. `{ "ordersAnonymised": 12 }`. */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  counts: Record<string, number>;

  /** Summe der geloeschten bzw. anonymisierten Datensaetze. */
  @Column({ type: 'int', default: 0 })
  total: number;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  @Column({ name: 'executed_by_user_id', type: 'uuid', nullable: true })
  executedByUserId: string | null;

  /** Anlass einer Einzelloeschung (z. B. Datum und Weg der Weisung). */
  @Column({ type: 'varchar', length: 500, nullable: true })
  reason: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt: Date;
}
