import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';

/**
 * A reusable deposit ("Pfand") type, e.g. "Becher" (2 €) or "Flasche" (0,15 €).
 * Organization-scoped config that products reference via Product.pfandTypeId.
 */
@Entity('pfand_types')
@Index(['organizationId'])
export class PfandType extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  /** Deposit amount in EUR charged per unit when sold (and refunded on return). */
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  // Relations
  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;
}
