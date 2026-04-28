import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Event } from './event.entity';
import { Printer } from './printer.entity';

@Entity('production_stations')
@Index(['eventId', 'sortOrder'])
export class ProductionStation extends BaseEntity {
  @Column({ name: 'event_id', type: 'uuid' })
  eventId: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 7, nullable: true })
  color: string | null;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'printer_id', type: 'uuid', nullable: true })
  printerId: string | null;

  // Relations
  @ManyToOne(() => Event, (event) => event.productionStations, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event: Event;

  @ManyToOne(() => Printer, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'printer_id' })
  printer: Printer | null;
}
