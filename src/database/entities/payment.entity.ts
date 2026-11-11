import {
  Entity,
  Column,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';
import { BaseEntity } from './base.entity';
import { Order } from './order.entity';
import { User } from './user.entity';
import { Device } from './device.entity';
import { OrderItemPayment } from './order-item-payment.entity';

export enum PaymentMethod {
  CASH = 'cash',
  CARD = 'card',
  SUMUP_TERMINAL = 'sumup_terminal',
  SUMUP_ONLINE = 'sumup_online',
  PAYPAL = 'paypal',
  GOOGLE_PAY = 'google_pay',
  APPLE_PAY = 'apple_pay',
  /**
   * Nur mit Wertmarken bezahlt (`amount` 0, Wert in `tokenAmount`). Bei
   * Marken plus Geld traegt die Zahlung die Zahlart des Geldes.
   */
  TOKENS = 'tokens',
}

export enum PaymentProvider {
  CASH = 'CASH',
  CARD = 'CARD',
  SUMUP = 'SUMUP',
  PAYPAL = 'PAYPAL',
  TOKENS = 'TOKENS',
}

export enum PaymentTransactionStatus {
  PENDING = 'pending',
  AUTHORIZED = 'authorized',
  CAPTURED = 'captured',
  FAILED = 'failed',
  REFUNDED = 'refunded',
}

/**
 * Mit Wertmarken beglichener Anteil einer Zahlung je Markentyp
 * (Schnappschuss). `count` ist der Anteil der Marken, der auf diese
 * Bestellung entfaellt (bei mehreren Bestellungen einer Kassierung ggf.
 * Bruchteile), `amount` der Wert in Euro.
 */
export interface PaymentTokenLine {
  tokenTypeId: string;
  name: string;
  kind: 'multi_purpose' | 'single_purpose';
  unitValue: number;
  count: number;
  amount: number;
  /** Satz bei Einzweckgutschein, sonst null. */
  vatRate: number | null;
}

export interface PaymentMetadata {
  cardLastFour?: string;
  cardBrand?: string;
  receiptUrl?: string;
  [key: string]: unknown;
}

@Entity('payments')
@Index(['orderId'])
export class Payment extends BaseEntity {
  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({
    name: 'payment_method',
    type: 'enum',
    enum: PaymentMethod,
    enumName: 'payment_method',
  })
  paymentMethod: PaymentMethod;

  @Column({ name: 'payment_provider', type: 'varchar', length: 50 })
  paymentProvider: PaymentProvider;

  @Column({
    name: 'provider_transaction_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  providerTransactionId: string | null;

  @Column({
    type: 'enum',
    enum: PaymentTransactionStatus,
    enumName: 'payment_transaction_status',
    default: PaymentTransactionStatus.PENDING,
  })
  status: PaymentTransactionStatus;

  @Column({ type: 'jsonb', default: {} })
  metadata: PaymentMetadata;

  @Column({ name: 'processed_by_user_id', type: 'uuid', nullable: true })
  processedByUserId: string | null;

  @Column({ name: 'processed_by_device_id', type: 'uuid', nullable: true })
  processedByDeviceId: string | null;

  /** Kassiert von (Bedienungs-Sitzung an der Kasse). */
  @Column({ name: 'processed_by_waiter_id', type: 'uuid', nullable: true })
  processedByWaiterId: string | null;

  /** Bargeld liegt in der Kellnerbrieftasche dieser Bedienung (P3, nach SB1). */
  @Column({ name: 'wallet_waiter_id', type: 'uuid', nullable: true })
  walletWaiterId: string | null;

  /** Trinkgeld, das mit dieser Zahlung kassiert wurde (Teil von `amount`). */
  @Column({
    name: 'tip_amount',
    type: 'decimal',
    precision: 10,
    scale: 2,
    default: 0,
  })
  tipAmount: number;

  /**
   * Mit Wertmarken beglichen (Euro). Nicht in `amount`: `amount` ist das
   * erhaltene Geld in `paymentMethod`. Beglichen insgesamt = amount +
   * tokenAmount.
   */
  @Column({
    name: 'token_amount',
    type: 'decimal',
    precision: 10,
    scale: 2,
    default: 0,
  })
  tokenAmount: number;

  @Column({ name: 'token_lines', type: 'jsonb', default: [] })
  tokenLines: PaymentTokenLine[];

  // Relations
  @ManyToOne(() => Order, (order) => order.payments, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @ManyToOne(() => User, (user) => user.processedPayments, {
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'processed_by_user_id' })
  processedByUser: User | null;

  @ManyToOne(() => Device, (device) => device.processedPayments, {
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'processed_by_device_id' })
  processedByDevice: Device | null;

  @OneToMany(() => OrderItemPayment, (itemPayment) => itemPayment.payment)
  itemPayments: OrderItemPayment[];

  // Helper methods
  isSuccessful(): boolean {
    return this.status === PaymentTransactionStatus.CAPTURED;
  }
}
