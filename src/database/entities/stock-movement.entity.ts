import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Event } from './event.entity';
import { Product } from './product.entity';
import { User } from './user.entity';

export enum StockMovementType {
  INITIAL = 'initial',
  SALE = 'sale',
  SALE_CANCELLED = 'sale_cancelled',
  PURCHASE = 'purchase',
  ADJUSTMENT_PLUS = 'adjustment_plus',
  ADJUSTMENT_MINUS = 'adjustment_minus',
  INVENTORY_COUNT = 'inventory_count',
  WASTE = 'waste',
  TRANSFER_IN = 'transfer_in',
  TRANSFER_OUT = 'transfer_out',
}

@Entity('stock_movements')
@Index(['productId', 'createdAt'])
@Index(['eventId', 'createdAt'])
export class StockMovement extends BaseEntity {
  @Column({ name: 'event_id', type: 'uuid' })
  eventId: string;

  @Column({ name: 'product_id', type: 'uuid' })
  productId: string;

  @Column({ type: 'enum', enum: StockMovementType, enumName: 'stock_movement_type' })
  type: StockMovementType;

  @Column({ type: 'int' })
  quantity: number;

  @Column({ name: 'quantity_before', type: 'int' })
  quantityBefore: number;

  @Column({ name: 'quantity_after', type: 'int' })
  quantityAfter: number;

  @Column({ name: 'reference_type', type: 'varchar', length: 50, nullable: true })
  referenceType: string | null;

  @Column({ name: 'reference_id', type: 'uuid', nullable: true })
  referenceId: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reason: string | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId: string | null;

  // Relations
  @ManyToOne(() => Event, (event) => event.stockMovements, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event: Event;

  @ManyToOne(() => Product, (product) => product.stockMovements, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @ManyToOne(() => User, (user) => user.stockMovements, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'created_by_user_id' })
  createdByUser: User | null;
}
