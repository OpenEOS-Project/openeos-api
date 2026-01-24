import { Entity, Column, OneToMany, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { CreditPurchase } from './credit-purchase.entity';

@Entity('credit_packages')
@Index(['slug'], { unique: true })
@Index(['sortOrder'])
export class CreditPackage extends BaseEntity {
  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 50, unique: true })
  slug: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'int' })
  credits: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  price: number;

  @Column({ name: 'price_per_credit', type: 'decimal', precision: 10, scale: 2 })
  pricePerCredit: number;

  @Column({ name: 'savings_percent', type: 'int', default: 0 })
  savingsPercent: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'is_featured', type: 'boolean', default: false })
  isFeatured: boolean;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  // Stripe Fields
  @Column({ name: 'stripe_product_id', type: 'varchar', length: 255, nullable: true })
  stripeProductId: string | null;

  @Column({ name: 'stripe_price_id', type: 'varchar', length: 255, nullable: true })
  stripePriceId: string | null;

  // Relations
  @OneToMany(() => CreditPurchase, (purchase) => purchase.package)
  purchases: CreditPurchase[];
}
