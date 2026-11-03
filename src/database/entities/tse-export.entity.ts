import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { TseUnit } from './tse-unit.entity';

/** `pending`: bei Swissbit in Arbeit; `downloaded`: TAR liegt im Archiv; `failed`. */
export type TseExportStatus = 'pending' | 'downloaded' | 'failed';

/**
 * Wer den Export angestossen hat: unser naechtlicher Lauf, ein Admin, die
 * Deaktivierung (Swissbit exportiert den Rest selbst) oder Swissbit
 * automatisch (gefunden, ohne dass wir ihn gestartet haben).
 */
export type TseExportTrigger =
  | 'scheduled'
  | 'manual'
  | 'deactivation'
  | 'swissbit';

/**
 * TAR-Export einer TSE (TR-03153). Exporte sind inkrementell; die Datei
 * liegt unter `TSE_EXPORT_DIR/<org>/<serial>/<zeitraum>.tar` (nicht
 * oeffentlich) mit SHA-256. Erst nach erfolgreichem Download wird der
 * Export bei Swissbit geloescht (`remote_deleted_at`).
 *
 * `archived_at`/`archive_ref`: Ablage im Langzeitarchiv (ELeFANT, folgt).
 */
@Entity('tse_exports')
@Index('IDX_tse_exports_org', ['organizationId', 'createdAt'])
@Index('UQ_tse_exports_unit_export', ['tseUnitId', 'swissbitExportId'], {
  unique: true,
})
export class TseExport extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'tse_unit_id', type: 'uuid' })
  tseUnitId: string;

  @ManyToOne(() => TseUnit, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'tse_unit_id' })
  tseUnit?: TseUnit;

  @Column({ name: 'serial_number', type: 'varchar', length: 128 })
  serialNumber: string;

  @Column({ name: 'swissbit_export_id', type: 'varchar', length: 100 })
  swissbitExportId: string;

  @Column({ type: 'varchar', length: 20 })
  status: TseExportStatus;

  @Column({ type: 'varchar', length: 20 })
  trigger: TseExportTrigger;

  /** Dateiname laut TSE (TR-03153), z. B. `Export_Unixt_1709386390.tar`. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  filename: string | null;

  /** Pfad relativ zu TSE_EXPORT_DIR. */
  @Column({ name: 'file_path', type: 'text', nullable: true })
  filePath: string | null;

  @Column({ type: 'char', length: 64, nullable: true })
  sha256: string | null;

  @Column({ name: 'size_bytes', type: 'bigint', nullable: true })
  sizeBytes: string | null;

  @Column({
    name: 'period_from',
    type: 'timestamp with time zone',
    nullable: true,
  })
  periodFrom: Date | null;

  @Column({
    name: 'period_to',
    type: 'timestamp with time zone',
    nullable: true,
  })
  periodTo: Date | null;

  @Column({
    name: 'swissbit_created_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  swissbitCreatedAt: Date | null;

  @Column({
    name: 'downloaded_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  downloadedAt: Date | null;

  @Column({
    name: 'remote_deleted_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  remoteDeletedAt: Date | null;

  @Column({
    name: 'archived_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  archivedAt: Date | null;

  @Column({ name: 'archive_ref', type: 'varchar', length: 255, nullable: true })
  archiveRef: string | null;

  @Column({ name: 'requested_by_user_id', type: 'uuid', nullable: true })
  requestedByUserId: string | null;

  @Column({ name: 'error_code', type: 'varchar', length: 60, nullable: true })
  errorCode: string | null;

  @Column({
    name: 'error_message',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  errorMessage: string | null;
}
