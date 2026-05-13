import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';
import { Event } from './event.entity';
import { Order } from './order.entity';

export enum ShopCheckoutStatus {
  PENDING = 'pending',
  PAID = 'paid',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum ShopCheckoutFulfillment {
  COUNTER_PICKUP = 'counter_pickup',
  TABLE_SERVICE = 'table_service',
}

export interface ShopCheckoutItemOption {
  group: string;
  option: string;
  priceModifier: number;
  excluded?: boolean;
}

export interface ShopCheckoutItem {
  productId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  options?: ShopCheckoutItemOption[];
}

export interface ShopCheckoutAddress {
  street?: string;
  postalCode?: string;
  city?: string;
  country?: string;
}

export interface ShopCheckoutCustomerName {
  firstName?: string;
  lastName?: string;
}

@Entity('shop_checkouts')
@Index(['organizationId', 'status'])
@Index(['eventId'])
@Index(['sumupCheckoutId'])
export class ShopCheckout extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId: string;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ name: 'customer_name', type: 'jsonb', nullable: true })
  customerName: ShopCheckoutCustomerName | null;

  @Column({ type: 'jsonb', nullable: true })
  address: ShopCheckoutAddress | null;

  @Column({ type: 'jsonb' })
  items: ShopCheckoutItem[];

  @Column({ name: 'total_amount', type: 'decimal', precision: 12, scale: 2 })
  totalAmount: string;

  @Column({ name: 'service_fee', type: 'decimal', precision: 12, scale: 2, default: 0 })
  serviceFee: string;

  @Column({
    name: 'fulfillment_type',
    type: 'enum',
    enum: ShopCheckoutFulfillment,
    enumName: 'shop_checkout_fulfillment',
    default: ShopCheckoutFulfillment.COUNTER_PICKUP,
  })
  fulfillmentType: ShopCheckoutFulfillment;

  @Column({ name: 'table_number', type: 'varchar', length: 50, nullable: true })
  tableNumber: string | null;

  @Column({ type: 'varchar', length: 3, default: 'EUR' })
  currency: string;

  @Column({ name: 'sumup_checkout_id', type: 'varchar', length: 255, nullable: true })
  sumupCheckoutId: string | null;

  @Column({ name: 'sumup_checkout_url', type: 'text', nullable: true })
  sumupCheckoutUrl: string | null;

  @Column({
    type: 'enum',
    enum: ShopCheckoutStatus,
    enumName: 'shop_checkout_status',
    default: ShopCheckoutStatus.PENDING,
  })
  status: ShopCheckoutStatus;

  @Column({ name: 'order_id', type: 'uuid', nullable: true })
  orderId: string | null;

  @Column({ name: 'paid_at', type: 'timestamp with time zone', nullable: true })
  paidAt: Date | null;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @ManyToOne(() => Event, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event: Event;

  @ManyToOne(() => Order, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'order_id' })
  order: Order | null;
}
