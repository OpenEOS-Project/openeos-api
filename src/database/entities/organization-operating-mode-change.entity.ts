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
 * Protokoll des Betriebsmodus (`settings.operatingMode`, `pos` oder
 * `order_only`).
 *
 * Ein Bestellsystem ohne Kassenmodul ist nur dann frei von der TSE-Pflicht,
 * wenn der Verein das Kassenmodul nicht selbst einschalten kann. Deshalb
 * schaltet nur der Support (Super-Admin) um, immer mit Grund — und jede
 * Umschaltung steht hier mit Zeitpunkt, Person, Grund und altem/neuem
 * Modus. Die Herstellerbescheinigung druckt diesen Verlauf ab. Nur
 * anhaengen, nie aendern; der Name bleibt als Kopie, auch wenn das Konto
 * spaeter geloescht wird.
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

  /** Anlass, z. B. „Antrag des Vereins per E-Mail vom 01.11.2026“. */
  @Column({ type: 'text' })
  reason: string;

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
