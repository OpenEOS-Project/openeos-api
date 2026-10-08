import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Order } from './order.entity';

/**
 * Verlauf einer Bestellung fuer Vorgaenge, die sich nicht aus den
 * Zeitstempeln der Bestellung, Positionen und Zahlungen ablesen lassen:
 * Storno von Positionen, Erstattungen (auch gescheiterte Versuche beim
 * Anbieter), Nachdrucke. Jede Storno-/Erstattungsaktion steht hier mit
 * Geraet und Bediener (Protokoll).
 */
export const ORDER_EVENT_TYPES = [
  'items_cancelled',
  'order_cancelled',
  'refunded',
  'refund_failed',
  'receipt_reprinted',
  'tickets_reprinted',
  'refund_receipt_reprinted',
] as const;
export type OrderEventType = (typeof ORDER_EVENT_TYPES)[number];

@Entity('order_events')
@Index(['orderId', 'createdAt'])
export class OrderEvent extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  @Column({ type: 'varchar', length: 40 })
  type: OrderEventType;

  @Column({ name: 'device_id', type: 'uuid', nullable: true })
  deviceId: string | null;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ name: 'actor_name', type: 'varchar', length: 255, nullable: true })
  actorName: string | null;

  @Column({ type: 'jsonb', default: {} })
  data: Record<string, unknown>;

  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Order;
}
