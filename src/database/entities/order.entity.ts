import { Entity, Column, ManyToOne, OneToMany, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';
import { Event } from './event.entity';
import { User } from './user.entity';
import { Device } from './device.entity';
import { OnlineOrderSession } from './online-order-session.entity';
import { OrderItem } from './order-item.entity';
import { Payment } from './payment.entity';

export enum OrderStatus {
  OPEN = 'open',
  IN_PROGRESS = 'in_progress',
  READY = 'ready',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

export enum PaymentStatus {
  UNPAID = 'unpaid',
  PARTLY_PAID = 'partly_paid',
  PAID = 'paid',
  REFUNDED = 'refunded',
}

export enum OrderSource {
  POS = 'pos',
  ONLINE = 'online',
  QR_ORDER = 'qr_order',
}

export enum OrderPriority {
  NORMAL = 'normal',
  HIGH = 'high',
  RUSH = 'rush',
}

@Entity('orders')
@Index(['organizationId', 'createdAt'])
@Index(['orderNumber'])
@Index(['eventId', 'dailyNumber'])
@Index(['status', 'paymentStatus'])
export class Order extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'event_id', type: 'uuid', nullable: true })
  eventId: string | null;

  @Column({ name: 'order_number', type: 'varchar', length: 50 })
  orderNumber: string;

  @Column({ name: 'daily_number', type: 'int' })
  dailyNumber: number;

  @Column({ name: 'table_number', type: 'varchar', length: 20, nullable: true })
  tableNumber: string | null;

  @Column({ name: 'customer_name', type: 'varchar', length: 255, nullable: true })
  customerName: string | null;

  @Column({ name: 'customer_phone', type: 'varchar', length: 50, nullable: true })
  customerPhone: string | null;

  @Column({ type: 'enum', enum: OrderStatus, enumName: 'order_status', default: OrderStatus.OPEN })
  status: OrderStatus;

  @Column({ name: 'payment_status', type: 'enum', enum: PaymentStatus, enumName: 'order_payment_status', default: PaymentStatus.UNPAID })
  paymentStatus: PaymentStatus;

  @Column({ type: 'enum', enum: OrderSource, enumName: 'order_source', default: OrderSource.POS })
  source: OrderSource;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  subtotal: number;

  @Column({ name: 'tax_total', type: 'decimal', precision: 10, scale: 2, default: 0 })
  taxTotal: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  total: number;

  @Column({ name: 'paid_amount', type: 'decimal', precision: 10, scale: 2, default: 0 })
  paidAmount: number;

  @Column({ name: 'tip_amount', type: 'decimal', precision: 10, scale: 2, default: 0 })
  tipAmount: number;

  @Column({ name: 'discount_amount', type: 'decimal', precision: 10, scale: 2, default: 0 })
  discountAmount: number;

  @Column({ name: 'discount_reason', type: 'varchar', length: 255, nullable: true })
  discountReason: string | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ type: 'enum', enum: OrderPriority, enumName: 'order_priority', default: OrderPriority.NORMAL })
  priority: OrderPriority;

  @Column({ name: 'estimated_ready_at', type: 'timestamp with time zone', nullable: true })
  estimatedReadyAt: Date | null;

  @Column({ name: 'ready_at', type: 'timestamp with time zone', nullable: true })
  readyAt: Date | null;

  @Column({ name: 'completed_at', type: 'timestamp with time zone', nullable: true })
  completedAt: Date | null;

  @Column({ name: 'cancelled_at', type: 'timestamp with time zone', nullable: true })
  cancelledAt: Date | null;

  @Column({ name: 'cancellation_reason', type: 'varchar', length: 255, nullable: true })
  cancellationReason: string | null;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId: string | null;

  @Column({ name: 'created_by_device_id', type: 'uuid', nullable: true })
  createdByDeviceId: string | null;

  @Column({ name: 'online_session_id', type: 'uuid', nullable: true })
  onlineSessionId: string | null;

  // Relations
  @ManyToOne(() => Organization, (org) => org.orders, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @ManyToOne(() => Event, (event) => event.orders, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'event_id' })
  event: Event | null;

  @ManyToOne(() => User, (user) => user.createdOrders, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'created_by_user_id' })
  createdByUser: User | null;

  @ManyToOne(() => Device, (device) => device.createdOrders, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'created_by_device_id' })
  createdByDevice: Device | null;

  @ManyToOne(() => OnlineOrderSession, (session) => session.orders, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'online_session_id' })
  onlineSession: OnlineOrderSession | null;

  @OneToMany(() => OrderItem, (item) => item.order, { cascade: true })
  items: OrderItem[];

  @OneToMany(() => Payment, (payment) => payment.order)
  payments: Payment[];

  // Helper methods
  get remainingAmount(): number {
    return Number(this.total) - Number(this.paidAmount);
  }

  isFullyPaid(): boolean {
    return Number(this.paidAmount) >= Number(this.total);
  }
}
