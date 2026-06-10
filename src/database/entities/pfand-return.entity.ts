import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';

export interface PfandReturnLine {
  pfandTypeId: string;
  name: string;
  /** Deposit amount per unit at the time of the return. */
  unitAmount: number;
  quantity: number;
}

/**
 * Ledger record of a deposit payout ("Pfand-Rückgabe"): money handed back to a
 * guest when they return empties. Kept separate from payments because the
 * payment table is income-only (positive amounts, no payout path).
 */
@Entity('pfand_returns')
@Index(['organizationId'])
@Index(['eventId'])
export class PfandReturn extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'event_id', type: 'uuid', nullable: true })
  eventId: string | null;

  @Column({ name: 'device_id', type: 'uuid', nullable: true })
  deviceId: string | null;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId: string | null;

  /** Total amount paid back to the guest, in EUR. */
  @Column({ name: 'total_amount', type: 'decimal', precision: 10, scale: 2 })
  totalAmount: number;

  @Column({ type: 'jsonb', default: [] })
  lines: PfandReturnLine[];

  // Relations
  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;
}
