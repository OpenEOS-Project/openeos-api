import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';
import { numericTransformer } from '../transformers/numeric.transformer';

/** Standard-Steuersatz einer Pfandart: der der Getraenke (meist 19 %). */
export const DEFAULT_PFAND_VAT_RATE = 19;

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

  /**
   * Umsatzsteuersatz des Pfands in Prozent. Pfand gehoert zum Entgelt
   * (Abschn. 10.1 Abs. 8 UStAE) und teilt den Satz der Ware, fuer die es
   * gilt — meist 19 %. Ein Satz je Pfandart; Pfandarten fuer Waren mit
   * unterschiedlichen Saetzen werden getrennt angelegt. Steuerbefreite
   * Organisationen (Kleinunternehmer) weisen trotzdem keine MwSt aus.
   */
  @Column({
    name: 'vat_rate',
    type: 'decimal',
    precision: 5,
    scale: 2,
    default: DEFAULT_PFAND_VAT_RATE,
    transformer: numericTransformer,
  })
  vatRate: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  // Relations
  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;
}
