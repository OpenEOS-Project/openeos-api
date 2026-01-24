import { Entity, Column, ManyToOne, OneToMany, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';
import { Category } from './category.entity';
import { Product } from './product.entity';
import { Order } from './order.entity';
import { QrCode } from './qr-code.entity';
import { OnlineOrderSession } from './online-order-session.entity';
import { EventLicense } from './event-license.entity';
import { RentalAssignment } from './rental-assignment.entity';
import { StockMovement } from './stock-movement.entity';
import { InventoryCount } from './inventory-count.entity';

export enum EventStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

export interface EventSettings {
  orderNumberPrefix?: string;
  enableOnlineOrdering?: boolean;
  enableTableService?: boolean;
  enableTakeaway?: boolean;
  maxOrdersPerHour?: number;
  [key: string]: unknown;
}

@Entity('events')
@Index(['organizationId', 'createdAt'])
@Index(['status'])
export class Event extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'copied_from_event_id', type: 'uuid', nullable: true })
  copiedFromEventId: string | null;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'start_date', type: 'timestamp with time zone' })
  startDate: Date;

  @Column({ name: 'end_date', type: 'timestamp with time zone' })
  endDate: Date;

  @Column({ type: 'enum', enum: EventStatus, enumName: 'event_status', default: EventStatus.DRAFT })
  status: EventStatus;

  @Column({ type: 'jsonb', default: {} })
  settings: EventSettings;

  // Relations
  @ManyToOne(() => Organization, (org) => org.events, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @ManyToOne(() => Event, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'copied_from_event_id' })
  copiedFromEvent: Event | null;

  @OneToMany(() => Category, (category) => category.event)
  categories: Category[];

  @OneToMany(() => Product, (product) => product.event)
  products: Product[];

  @OneToMany(() => Order, (order) => order.event)
  orders: Order[];

  @OneToMany(() => QrCode, (qrCode) => qrCode.event)
  qrCodes: QrCode[];

  @OneToMany(() => OnlineOrderSession, (session) => session.event)
  onlineOrderSessions: OnlineOrderSession[];

  @OneToMany(() => EventLicense, (license) => license.event)
  eventLicenses: EventLicense[];

  @OneToMany(() => RentalAssignment, (rental) => rental.event)
  rentalAssignments: RentalAssignment[];

  @OneToMany(() => StockMovement, (movement) => movement.event)
  stockMovements: StockMovement[];

  @OneToMany(() => InventoryCount, (count) => count.event)
  inventoryCounts: InventoryCount[];

  // Helper methods
  get durationInDays(): number {
    const diffTime = Math.abs(this.endDate.getTime() - this.startDate.getTime());
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }

  isActive(): boolean {
    return this.status === EventStatus.ACTIVE;
  }
}
