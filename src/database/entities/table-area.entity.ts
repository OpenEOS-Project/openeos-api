import { Entity, Column, ManyToOne, OneToMany, JoinColumn } from 'typeorm';
import { SoftDeleteEntity } from './base.entity';
import { Organization } from './organization.entity';
import { DiningTable } from './dining-table.entity';

export type TableAreaDecorType = 'bar' | 'wall' | 'stage' | 'label';

/** Deko-Element auf der Karte eines Bereichs (Theke, Wand, Buehne, Beschriftung). */
export interface TableAreaDecor {
  id: string;
  type: TableAreaDecorType;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  label?: string;
}

/**
 * Bereich (Raum/Zone) mit eigener Tischkarte, z. B. „Zelt A“ oder
 * „Biergarten“. Liegt auf Organisationsebene; die Veranstaltung waehlt
 * ueber `settings.tables.areaIds`, welche Bereiche sie nutzt.
 *
 * Der Name ist je Organisation eindeutig (Index
 * `UQ_table_areas_org_name` auf `lower(name)`, nur nicht geloeschte).
 */
@Entity('table_areas')
export class TableArea extends SoftDeleteEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ type: 'varchar', length: 60 })
  name: string;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  /** Breite der Karte in Einheiten. */
  @Column({ type: 'int', default: 1200 })
  width: number;

  /** Hoehe der Karte in Einheiten. */
  @Column({ type: 'int', default: 800 })
  height: number;

  @Column({ name: 'grid_size', type: 'int', default: 20 })
  gridSize: number;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  decor: TableAreaDecor[];

  // Relations
  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @OneToMany(() => DiningTable, (table) => table.area)
  tables: DiningTable[];
}
