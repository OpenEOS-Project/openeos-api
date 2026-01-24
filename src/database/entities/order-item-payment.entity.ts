import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Payment } from './payment.entity';
import { OrderItem } from './order-item.entity';

@Entity('order_item_payments')
@Index(['paymentId'])
@Index(['orderItemId'])
export class OrderItemPayment extends BaseEntity {
  @Column({ name: 'payment_id', type: 'uuid' })
  paymentId: string;

  @Column({ name: 'order_item_id', type: 'uuid' })
  orderItemId: string;

  @Column({ type: 'int' })
  quantity: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  // Relations
  @ManyToOne(() => Payment, (payment) => payment.itemPayments, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'payment_id' })
  payment: Payment;

  @ManyToOne(() => OrderItem, (item) => item.itemPayments, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_item_id' })
  orderItem: OrderItem;
}
