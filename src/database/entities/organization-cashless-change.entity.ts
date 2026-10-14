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
 * Protokoll des bargeldlosen Modus (`settings.payments.cashless`).
 *
 * Ob eine Kasse eine „Kassenfunktion“ hat, haengt daran, ob sie Bargeld
 * erfassen kann — auch daran, ob sich Bargeld wieder einschalten laesst.
 * Damit der Verein belegen kann, ab wann seine Kassen bargeldlos liefen,
 * steht jede Umschaltung hier mit Zeitpunkt und handelnder Person. Nur
 * anhaengen, nie aendern; die Zeilen bleiben, auch wenn die Person spaeter
 * geloescht wird (Name als Kopie).
 */
@Entity('organization_cashless_changes')
@Index(['organizationId', 'createdAt'])
export class OrganizationCashlessChange {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt: Date;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  /** Neuer Zustand: true = bargeldlos ab jetzt. */
  @Column({ type: 'boolean' })
  cashless: boolean;

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
