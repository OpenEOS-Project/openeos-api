import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';

export enum DiscountVoucherType {
  /** Fixed discount amount, e.g. a 3 € artist voucher. */
  FIXED = 'fixed',
  /** Amount is entered by the cashier on redemption, e.g. a "free meal" voucher. */
  MANUAL = 'manual',
}

@Entity('discount_vouchers')
@Index(['organizationId'])
export class DiscountVoucher extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description: string | null;

  @Column({
    type: 'enum',
    enum: DiscountVoucherType,
    enumName: 'discount_voucher_type',
  })
  type: DiscountVoucherType;

  /** Discount amount in EUR. Required for FIXED vouchers, null for MANUAL vouchers. */
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  amount: number | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  /** Whether the voucher may be applied more than once to the same order. */
  @Column({ name: 'allow_multiple_per_order', type: 'boolean', default: false })
  allowMultiplePerOrder: boolean;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  // Relations
  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;
}
