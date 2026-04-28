import { Entity, Column, ManyToOne, OneToMany, JoinColumn, Index } from 'typeorm';
import { SoftDeleteEntity } from './base.entity';
import { Event } from './event.entity';
import { Category } from './category.entity';
import { OrderItem } from './order-item.entity';
import { StockMovement } from './stock-movement.entity';
import { InventoryCountItem } from './inventory-count-item.entity';
import { ProductionStation } from './production-station.entity';

export interface ProductOption {
  name: string;
  priceModifier: number;
  default?: boolean;
}

export interface ProductOptionGroup {
  name: string;
  type: 'single' | 'multiple' | 'ingredients';
  required: boolean;
  options: ProductOption[];
}

export interface ProductOptions {
  groups: ProductOptionGroup[];
}

export interface ProductPrintSettings {
  printerId?: string;
  templateId?: string;
  copies?: number;
  enabled?: boolean;
}

@Entity('products')
@Index(['eventId', 'isActive'])
@Index(['eventId', 'categoryId'])
@Index(['categoryId'])
export class Product extends SoftDeleteEntity {
  @Column({ name: 'event_id', type: 'uuid' })
  eventId: string;

  @Column({ name: 'category_id', type: 'uuid' })
  categoryId: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  price: number;

  @Column({ name: 'image_url', type: 'varchar', length: 500, nullable: true })
  imageUrl: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'is_available', type: 'boolean', default: true })
  isAvailable: boolean;

  @Column({ name: 'track_inventory', type: 'boolean', default: false })
  trackInventory: boolean;

  @Column({ name: 'stock_quantity', type: 'int', default: 0 })
  stockQuantity: number;

  @Column({ name: 'stock_unit', type: 'varchar', length: 20, default: 'Stück' })
  stockUnit: string;

  @Column({ type: 'jsonb', default: { groups: [] } })
  options: ProductOptions;

  @Column({ name: 'print_settings', type: 'jsonb', nullable: true })
  printSettings: ProductPrintSettings | null;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @Column({ name: 'production_station_id', type: 'uuid', nullable: true })
  productionStationId: string | null;

  // Relations
  @ManyToOne(() => Event, (event) => event.products, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event: Event;

  @ManyToOne(() => Category, (category) => category.products, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'category_id' })
  category: Category;

  @ManyToOne(() => ProductionStation, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'production_station_id' })
  productionStation: ProductionStation | null;

  @OneToMany(() => OrderItem, (item) => item.product)
  orderItems: OrderItem[];

  @OneToMany(() => StockMovement, (movement) => movement.product)
  stockMovements: StockMovement[];

  @OneToMany(() => InventoryCountItem, (item) => item.product)
  inventoryCountItems: InventoryCountItem[];

  // Helper method
  isOutOfStock(): boolean {
    return this.trackInventory && this.stockQuantity <= 0;
  }
}
