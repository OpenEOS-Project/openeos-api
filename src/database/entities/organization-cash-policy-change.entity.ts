import {
  Entity,
  Column,
  CreateDateColumn,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Organization } from './organization.entity';

/**
 * Verlauf von Land und Bargeld-Regel einer Organisation (siehe
 * cash-policy.util.ts). Nur anhaengen, nie aendern.
 *
 * - `country`: Land gesetzt (einmalig durch den Verein) oder geaendert
 *   (nur Support, mit Grund).
 * - `policy`: Bestandsschutz beendet (freiwilliger Wechsel des Vereins auf
 *   „Deutschland ohne Bargeld“) oder durch den Support zurueckgesetzt.
 *
 * Der Verlauf steht auf der Herstellerbescheinigung; Aenderungen durch den
 * Support stehen zusaetzlich im Admin-Protokoll.
 */
export type CashPolicyChangeKind = 'country' | 'policy';

@Entity('organization_cash_policy_changes')
@Index(['organizationId', 'createdAt'])
export class OrganizationCashPolicyChange {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt: Date;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ type: 'varchar', length: 20 })
  kind: CashPolicyChangeKind;

  /** Vorher/nachher: Laendercode bzw. `legacy` / `country`. */
  @Column({ name: 'from_value', type: 'varchar', length: 20, nullable: true })
  fromValue: string | null;

  @Column({ name: 'to_value', type: 'varchar', length: 20 })
  toValue: string;

  /** Pflicht bei Aenderungen durch den Support. */
  @Column({ type: 'text', nullable: true })
  reason: string | null;

  /** true: durch den OpenEOS-Support (Super-Admin). */
  @Column({ name: 'by_support', type: 'boolean', default: false })
  bySupport: boolean;

  @Column({ name: 'changed_by_user_id', type: 'uuid', nullable: true })
  changedByUserId: string | null;

  /** Name und E-Mail zum Zeitpunkt der Aenderung. */
  @Column({
    name: 'changed_by_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  changedByName: string | null;

  @Column({ name: 'ip_address', type: 'varchar', length: 45, nullable: true })
  ipAddress: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 500, nullable: true })
  userAgent: string | null;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;
}
