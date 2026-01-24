import { Entity, Column, ManyToOne, OneToMany, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Order } from './order.entity';
import { Product } from './product.entity';
import { Category } from './category.entity';
import { OrderItemPayment } from './order-item-payment.entity';
import { PrintJob } from './print-job.entity';

export enum OrderItemStatus {
  PENDING = 'pending',
  PREPARING = 'preparing',
  READY = 'ready',
  DELIVERED = 'delivered',
  CANCELLED = 'cancelled',
}

export interface SelectedOption {
  group: string;
  option: string;
  priceModifier: number;
}

export interface OrderItemOptions {
  selected: SelectedOption[];
}

@Entity('order_items')
@Index(['orderId'])
@Index(['orderId', 'status'])
@Index(['productId'])
export class OrderItem extends BaseEntity {
  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  @Column({ name: 'product_id', type: 'uuid' })
  productId: string;

  @Column({ name: 'category_id', type: 'uuid' })
  categoryId: string;

  @Column({ name: 'product_name', type: 'varchar', length: 255 })
  productName: string;

  @Column({ name: 'category_name', type: 'varchar', length: 255 })
  categoryName: string;

  @Column({ type: 'int' })
  quantity: number;

  @Column({ name: 'unit_price', type: 'decimal', precision: 10, scale: 2 })
  unitPrice: number;

  @Column({ name: 'options_price', type: 'decimal', precision: 10, scale: 2, default: 0 })
  optionsPrice: number;

  @Column({ name: 'tax_rate', type: 'decimal', precision: 5, scale: 2 })
  taxRate: number;

  @Column({ name: 'total_price', type: 'decimal', precision: 10, scale: 2 })
  totalPrice: number;

  @Column({ type: 'jsonb', default: { selected: [] } })
  options: OrderItemOptions;

  @Column({ type: 'enum', enum: OrderItemStatus, enumName: 'order_item_status', default: OrderItemStatus.PENDING })
  status: OrderItemStatus;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ name: 'kitchen_notes', type: 'text', nullable: true })
  kitchenNotes: string | null;

  @Column({ name: 'paid_quantity', type: 'int', default: 0 })
  paidQuantity: number;

  @Column({ name: 'prepared_at', type: 'timestamp with time zone', nullable: true })
  preparedAt: Date | null;

  @Column({ name: 'ready_at', type: 'timestamp with time zone', nullable: true })
  readyAt: Date | null;

  @Column({ name: 'delivered_at', type: 'timestamp with time zone', nullable: true })
  deliveredAt: Date | null;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  // Relations
  @ManyToOne(() => Order, (order) => order.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @ManyToOne(() => Product, (product) => product.orderItems, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @ManyToOne(() => Category, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'category_id' })
  category: Category;

  @OneToMany(() => OrderItemPayment, (payment) => payment.orderItem)
  itemPayments: OrderItemPayment[];

  @OneToMany(() => PrintJob, (job) => job.orderItem)
  printJobs: PrintJob[];

  // Helper methods
  get unpaidQuantity(): number {
    return this.quantity - this.paidQuantity;
  }

  isFullyPaid(): boolean {
    return this.paidQuantity >= this.quantity;
  }
}
