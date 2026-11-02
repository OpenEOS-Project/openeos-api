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
import { User } from './user.entity';

/**
 * Verlauf der Betriebsart (operating-mode.util.ts): jeder Wechsel mit
 * Zeitpunkt, Person, altem und neuem Wert. Werte: `orders_only`,
 * `cashless`, `full` und `full_legacy` („Alle Funktionen (Bestand)“).
 *
 * Wechseln koennen die Admins des Vereins selbst (ohne Grund) und der
 * Support (`by_support`, immer mit Grund). Zeilen aus der Zeit vor den
 * Betriebsarten (Support-Schalter „Nur Bestellen“) wurden bei der Migration
 * auf die neuen Werte umgeschrieben; die Umstellung selbst steht als
 * eigene Zeile mit `by_support = true` darin. Die Herstellerbescheinigung
 * druckt diesen Verlauf ab. Nur anhaengen, nie aendern; der Name bleibt als
 * Kopie, auch wenn das Konto spaeter geloescht wird.
 */
@Entity('organization_operating_mode_changes')
@Index(['organizationId', 'createdAt'])
export class OrganizationOperatingModeChange {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt: Date;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'from_mode', type: 'varchar', length: 20 })
  fromMode: string;

  @Column({ name: 'to_mode', type: 'varchar', length: 20 })
  toMode: string;

  /** Anlass (Pflicht beim Support), z. B. „Antrag per E-Mail vom 01.11.2026“. */
  @Column({ type: 'text', nullable: true })
  reason: string | null;

  /** Durch den OpenEOS-Support (Super-Admin) bzw. die Migration. */
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

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'changed_by_user_id' })
  changedByUser: User | null;
}
