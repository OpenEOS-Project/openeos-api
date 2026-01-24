import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';
import { CreditPackage } from './credit-package.entity';
import { User } from './user.entity';
import { Invoice } from './invoice.entity';

export enum CreditPaymentMethod {
  STRIPE = 'stripe',
  SUMUP_ONLINE = 'sumup_online',
  BANK_TRANSFER = 'bank_transfer',
  INVOICE = 'invoice',
}

export enum CreditPaymentStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
  FAILED = 'failed',
  REFUNDED = 'refunded',
}

@Entity('credit_purchases')
@Index(['organizationId', 'createdAt'])
export class CreditPurchase extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'package_id', type: 'uuid' })
  packageId: string;

  @Column({ type: 'int' })
  credits: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ name: 'payment_method', type: 'enum', enum: CreditPaymentMethod, enumName: 'credit_payment_method' })
  paymentMethod: CreditPaymentMethod;

  @Column({ name: 'payment_status', type: 'enum', enum: CreditPaymentStatus, enumName: 'credit_payment_status', default: CreditPaymentStatus.PENDING })
  paymentStatus: CreditPaymentStatus;

  @Column({ name: 'transaction_id', type: 'varchar', length: 255, nullable: true })
  transactionId: string | null;

  @Column({ name: 'invoice_id', type: 'uuid', nullable: true })
  invoiceId: string | null;

  @Column({ name: 'purchased_by_user_id', type: 'uuid' })
  purchasedByUserId: string;

  @Column({ name: 'completed_at', type: 'timestamp with time zone', nullable: true })
  completedAt: Date | null;

  // Stripe Fields
  @Column({ name: 'stripe_payment_intent_id', type: 'varchar', length: 255, nullable: true })
  stripePaymentIntentId: string | null;

  @Column({ name: 'stripe_checkout_session_id', type: 'varchar', length: 255, nullable: true })
  stripeCheckoutSessionId: string | null;

  // Relations
  @ManyToOne(() => Organization, (org) => org.creditPurchases, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @ManyToOne(() => CreditPackage, (pkg) => pkg.purchases, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'package_id' })
  package: CreditPackage;

  @ManyToOne(() => User, (user) => user.creditPurchases, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'purchased_by_user_id' })
  purchasedByUser: User;

  @ManyToOne(() => Invoice, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'invoice_id' })
  invoice: Invoice | null;
}
