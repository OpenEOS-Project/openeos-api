import { Entity, Column, ManyToOne, OneToMany, JoinColumn, Index } from 'typeorm';
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
}

export enum PaymentProvider {
  CASH = 'CASH',
  CARD = 'CARD',
  SUMUP = 'SUMUP',
  PAYPAL = 'PAYPAL',
}

export enum PaymentTransactionStatus {
  PENDING = 'pending',
  AUTHORIZED = 'authorized',
  CAPTURED = 'captured',
  FAILED = 'failed',
  REFUNDED = 'refunded',
}

export interface PaymentMetadata {
  cardLastFour?: string;
  cardBrand?: string;
  receiptUrl?: string;
  [key: string]: unknown;
}

/**
 * Signed transaction record from the organization's TSE (Technische
 * Sicherheitseinrichtung), per KassenSichV. Populated by TseService right
 * after capture; `failed: true` marks a recorded TSE outage (BMF's
 * Ausfall-Regelung — the sale still completes, but the gap must be provable).
 */
export interface TseTransactionData {
  provider: 'fiskaly' | 'none';
  clientId: string;
  transactionNumber: number;
  serialNumber: string;
  signatureCounter: number;
  signatureValue: string;
  signatureAlgorithm: string;
  startTime: string;
  endTime: string;
  processType: string;
  processData: string;
  /** Pre-built payload for the receipt's TSE QR code. */
  qrCodeData: string;
  failed?: boolean;
  failureReason?: string;
}

@Entity('payments')
@Index(['orderId'])
export class Payment extends BaseEntity {
  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ name: 'payment_method', type: 'enum', enum: PaymentMethod, enumName: 'payment_method' })
  paymentMethod: PaymentMethod;

  @Column({ name: 'payment_provider', type: 'varchar', length: 50 })
  paymentProvider: PaymentProvider;

  @Column({ name: 'provider_transaction_id', type: 'varchar', length: 255, nullable: true })
  providerTransactionId: string | null;

  @Column({ type: 'enum', enum: PaymentTransactionStatus, enumName: 'payment_transaction_status', default: PaymentTransactionStatus.PENDING })
  status: PaymentTransactionStatus;

  @Column({ type: 'jsonb', default: {} })
  metadata: PaymentMetadata;

  @Column({ name: 'tse_data', type: 'jsonb', nullable: true, default: null })
  tseData: TseTransactionData | null;

  @Column({ name: 'processed_by_user_id', type: 'uuid', nullable: true })
  processedByUserId: string | null;

  @Column({ name: 'processed_by_device_id', type: 'uuid', nullable: true })
  processedByDeviceId: string | null;

  // Relations
  @ManyToOne(() => Order, (order) => order.payments, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @ManyToOne(() => User, (user) => user.processedPayments, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'processed_by_user_id' })
  processedByUser: User | null;

  @ManyToOne(() => Device, (device) => device.processedPayments, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'processed_by_device_id' })
  processedByDevice: Device | null;

  @OneToMany(() => OrderItemPayment, (itemPayment) => itemPayment.payment)
  itemPayments: OrderItemPayment[];

  // Helper methods
  isSuccessful(): boolean {
    return this.status === PaymentTransactionStatus.CAPTURED;
  }

  hasTseSignature(): boolean {
    return !!this.tseData && !this.tseData.failed;
  }
}
