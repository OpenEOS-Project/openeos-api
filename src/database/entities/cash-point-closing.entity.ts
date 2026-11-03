import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from './base.entity';

export type CashPointClosingTrigger = 'scheduled' | 'manual';

/**
 * Kassenabschluss (DSFinV-K, „Z-Bon“) der einen Kasse einer Organisation:
 * fortlaufende Z_NR, Geschaeftstag (6–6 Uhr), Zeitraum, Summen und die
 * fertigen Zeilen aller DSFinV-K-Tabellen (`rows`, Tabellenname → Zeilen)
 * mit SHA-256 (`content_sha256`). Unveraenderlich (Datenbank-Trigger);
 * nur die Ablage (Export-Datei, Archiv) wird nachgetragen.
 */
@Entity('cash_point_closings')
@Index('IDX_cash_point_closings_org_date', ['organizationId', 'businessDate'])
@Index('UQ_cash_point_closings_org_z_nr', ['organizationId', 'zNr'], {
  unique: true,
})
export class CashPointClosing extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  /** Z_KASSE_ID (= TSE-Client-ID `OEOS-…`). */
  @Column({ name: 'register_id', type: 'varchar', length: 30 })
  registerId: string;

  @Column({ name: 'z_nr', type: 'int' })
  zNr: number;

  /** `YYYY-MM-DD` */
  @Column({ name: 'business_date', type: 'date' })
  businessDate: string;

  @Column({
    name: 'period_from',
    type: 'timestamp with time zone',
    nullable: true,
  })
  periodFrom: Date | null;

  @Column({ name: 'period_to', type: 'timestamp with time zone' })
  periodTo: Date;

  /** Z_ERSTELLUNG (sekundengenau). */
  @Column({ name: 'closing_created_at', type: 'timestamp with time zone' })
  closingCreatedAt: Date;

  @Column({ type: 'varchar', length: 20 })
  trigger: CashPointClosingTrigger;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId: string | null;

  @Column({ name: 'first_bon_id', type: 'bigint', nullable: true })
  firstBonId: string | null;

  @Column({ name: 'last_bon_id', type: 'bigint', nullable: true })
  lastBonId: string | null;

  @Column({ name: 'transaction_count', type: 'int', default: 0 })
  transactionCount: number;

  @Column({ type: 'jsonb' })
  totals: Record<string, unknown>;

  @Column({ name: 'master_data', type: 'jsonb' })
  masterData: Record<string, unknown>;

  /** Tabellenname → Zeilen (formatierte Werte in Spaltenreihenfolge). */
  @Column({ type: 'jsonb', select: false })
  rows: Record<string, string[][]>;

  @Column({ name: 'content_sha256', type: 'char', length: 64 })
  contentSha256: string;

  @Column({ name: 'export_file_path', type: 'text', nullable: true })
  exportFilePath: string | null;

  @Column({ name: 'export_sha256', type: 'char', length: 64, nullable: true })
  exportSha256: string | null;

  @Column({ name: 'export_size_bytes', type: 'bigint', nullable: true })
  exportSizeBytes: string | null;

  @Column({
    name: 'exported_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  exportedAt: Date | null;

  /** Langzeitarchiv (ELeFANT, folgt). */
  @Column({
    name: 'archived_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  archivedAt: Date | null;

  @Column({
    name: 'archive_ref',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  archiveRef: string | null;
}
