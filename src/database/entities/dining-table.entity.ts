import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { SoftDeleteEntity } from './base.entity';
import { Organization } from './organization.entity';
import { TableArea } from './table-area.entity';

export enum DiningTableShape {
  RECT = 'rect',
  ROUND = 'round',
}

/**
 * Tisch in einem Bereich. `label` (z. B. „A03“ oder „12“) ist je
 * Organisation eindeutig, gross/klein egal (Index
 * `UQ_dining_tables_org_label` auf `upper(label)`, nur nicht geloeschte).
 * Lage und Groesse in Einheiten der Bereichskarte.
 */
@Entity('dining_tables')
@Index('IDX_dining_tables_area', ['areaId'])
export class DiningTable extends SoftDeleteEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'area_id', type: 'uuid' })
  areaId: string;

  @Column({ type: 'varchar', length: 20 })
  label: string;

  @Column({ type: 'smallint', nullable: true })
  seats: number | null;

  @Column({
    type: 'enum',
    enum: DiningTableShape,
    enumName: 'dining_table_shape',
    default: DiningTableShape.RECT,
  })
  shape: DiningTableShape;

  @Column({ type: 'int', default: 0 })
  x: number;

  @Column({ type: 'int', default: 0 })
  y: number;

  @Column({ type: 'int', default: 80 })
  width: number;

  @Column({ type: 'int', default: 80 })
  height: number;

  @Column({ type: 'smallint', default: 0 })
  rotation: number;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  // Relations
  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @ManyToOne(() => TableArea, (area) => area.tables, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'area_id' })
  area: TableArea;
}
