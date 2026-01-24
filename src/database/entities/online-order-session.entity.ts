import { Entity, Column, ManyToOne, OneToMany, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';
import { Event } from './event.entity';
import { QrCode } from './qr-code.entity';
import { Order } from './order.entity';

export enum OnlineOrderSessionStatus {
  ACTIVE = 'active',
  ORDERING = 'ordering',
  PAID = 'paid',
  COMPLETED = 'completed',
  EXPIRED = 'expired',
}

export interface CartItem {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  options: { group: string; option: string; priceModifier: number }[];
  notes?: string;
}

export interface SessionCart {
  items: CartItem[];
  updatedAt: string;
}

@Entity('online_order_sessions')
@Index(['sessionToken'], { unique: true })
@Index(['organizationId', 'status'])
export class OnlineOrderSession extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'event_id', type: 'uuid', nullable: true })
  eventId: string | null;

  @Column({ name: 'qr_code_id', type: 'uuid' })
  qrCodeId: string;

  @Column({ name: 'session_token', type: 'varchar', length: 255, unique: true })
  sessionToken: string;

  @Column({ name: 'table_number', type: 'varchar', length: 20, nullable: true })
  tableNumber: string | null;

  @Column({ name: 'customer_name', type: 'varchar', length: 100, nullable: true })
  customerName: string | null;

  @Column({ type: 'enum', enum: OnlineOrderSessionStatus, enumName: 'online_order_session_status', default: OnlineOrderSessionStatus.ACTIVE })
  status: OnlineOrderSessionStatus;

  @Column({ type: 'jsonb', default: { items: [], updatedAt: '' } })
  cart: SessionCart;

  @Column({ name: 'expires_at', type: 'timestamp with time zone' })
  expiresAt: Date;

  // Relations
  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @ManyToOne(() => Event, (event) => event.onlineOrderSessions, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'event_id' })
  event: Event | null;

  @ManyToOne(() => QrCode, (qrCode) => qrCode.sessions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'qr_code_id' })
  qrCode: QrCode;

  @OneToMany(() => Order, (order) => order.onlineSession)
  orders: Order[];

  // Helper methods
  isExpired(): boolean {
    return this.expiresAt < new Date();
  }
}
