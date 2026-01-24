import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { InventoryCount } from './inventory-count.entity';
import { Product } from './product.entity';
import { User } from './user.entity';

@Entity('inventory_count_items')
@Index(['inventoryCountId'])
@Index(['productId'])
export class InventoryCountItem extends BaseEntity {
  @Column({ name: 'inventory_count_id', type: 'uuid' })
  inventoryCountId: string;

  @Column({ name: 'product_id', type: 'uuid' })
  productId: string;

  @Column({ name: 'expected_quantity', type: 'int' })
  expectedQuantity: number;

  @Column({ name: 'counted_quantity', type: 'int', nullable: true })
  countedQuantity: number | null;

  @Column({ type: 'int', nullable: true })
  difference: number | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ name: 'counted_by_user_id', type: 'uuid', nullable: true })
  countedByUserId: string | null;

  @Column({ name: 'counted_at', type: 'timestamp with time zone', nullable: true })
  countedAt: Date | null;

  // Relations
  @ManyToOne(() => InventoryCount, (count) => count.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'inventory_count_id' })
  inventoryCount: InventoryCount;

  @ManyToOne(() => Product, (product) => product.inventoryCountItems, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'counted_by_user_id' })
  countedByUser: User | null;
}
