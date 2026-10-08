import { Entity, Column, ManyToOne, OneToMany, JoinColumn } from 'typeorm';
import { SoftDeleteEntity } from './base.entity';
import { Organization } from './organization.entity';
import { DiningTable } from './dining-table.entity';

export type TableAreaDecorType = 'bar' | 'wall' | 'stage' | 'label' | 'zone';
export type TableAreaZoneType = 'kitchen' | 'blocked' | 'bar' | 'other';

/** Punkt auf der Karte, in Einheiten des Bereichs. */
export interface TableAreaPoint {
  x: number;
  y: number;
}

/**
 * Rechteckiges Deko-Element (Theke, Wand, Buehne, Beschriftung) — das
 * urspruengliche Format, bleibt gueltig.
 */
export interface TableAreaRectDecor {
  id: string;
  type: 'bar' | 'wall' | 'stage' | 'label';
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  label?: string;
}

/** Wand als Linienzug (>= 2 Punkte); erkennbar an `points`. */
export interface TableAreaWallLine {
  id: string;
  type: 'wall';
  points: TableAreaPoint[];
  /** Staerke in Einheiten; fehlt → Darstellung mit 10. */
  thickness?: number;
}

/**
 * Zone (Polygon, >= 3 Punkte): Kueche, gesperrter Bereich, Bar/Theke,
 * Sonstiges. Reine Darstellung — Tische gehoeren nie zu einer Zone.
 */
export interface TableAreaZone {
  id: string;
  type: 'zone';
  zoneType: TableAreaZoneType;
  points: TableAreaPoint[];
  label?: string;
}

/**
 * Element in `table_areas.decor` (jsonb). Abwaertskompatibel: alte
 * Eintraege sind Rechtecke; `wall` mit `points` ist ein Linienzug,
 * `zone` ein Polygon.
 */
export type TableAreaDecor =
  | TableAreaRectDecor
  | TableAreaWallLine
  | TableAreaZone;

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

  /**
   * Umriss des Raums als Polygon (>= 3 Punkte, in Einheiten). `null` =
   * Rechteck der ganzen Karte (Bestand und Standard).
   */
  @Column({ type: 'jsonb', nullable: true, default: null })
  outline: TableAreaPoint[] | null;

  // Relations
  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @OneToMany(() => DiningTable, (table) => table.area)
  tables: DiningTable[];
}
