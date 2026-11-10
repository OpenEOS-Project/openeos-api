import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';
import { Event } from './event.entity';

/** Zwei feste Rollen (Entscheidung 5): Bedienung und Schichtleitung. */
export const WAITER_ROLES = ['service', 'lead'] as const;
export type WaiterRole = (typeof WAITER_ROLES)[number];

/** Die vier Schalter je Bedienung (Abweichungen von der Rolle). */
export const WAITER_PERMISSION_KEYS = [
  'refund',
  'cashDrawer',
  'discount',
  'cashbook',
] as const;
export type WaiterPermissionKey = (typeof WAITER_PERMISSION_KEYS)[number];
export type WaiterPermissions = Partial<Record<WaiterPermissionKey, boolean>>;

/**
 * Bedienung (Kassenprofil ohne Konto und ohne E-Mail), bedienungen-plan.md
 * §4. Meldet sich an Kassen per PIN an (`pin_credentials`), die PIN selbst
 * steht hier nicht. `eventId` leer = organisationsweit, sonst nur nutzbar,
 * solange diese Veranstaltung aktiv bzw. im Test ist.
 */
@Entity('waiters')
@Index('IDX_waiters_org_active', ['organizationId', 'isActive'])
export class Waiter extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'event_id', type: 'uuid', nullable: true })
  eventId: string | null;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ name: 'short_name', type: 'varchar', length: 12, nullable: true })
  shortName: string | null;

  /** Farbe als #rrggbb (Kopf-Chip, Tische). */
  @Column({ type: 'varchar', length: 7, nullable: true })
  color: string | null;

  @Column({ type: 'varchar', length: 20, default: 'service' })
  role: WaiterRole;

  @Column({ type: 'jsonb', default: {} })
  permissions: WaiterPermissions;

  /**
   * Kellnerbrieftasche je Person (NULL = Vorgabe der Organisation). Erst
   * nach Antwort des Steuerberaters (SB1) wirksam; bis dahin ungenutzt.
   */
  @Column({ type: 'boolean', nullable: true })
  wallet: boolean | null;

  /**
   * „Arbeitnehmer (Lohnkonto)“: angestellte Bedienung (Minijob, Lohnkonto).
   * Nur dann ist ihr Trinkgeld `TrinkgeldAN` (kein Entgelt, § 3 Nr. 51
   * EStG) und darf Kartentrinkgeld bar ausgezahlt werden. Standard aus:
   * Ehrenamtliche liefern das Trinkgeld beim Verein ab → `TrinkgeldAG`
   * mit dem Satz der Hauptleistung (Steuerberater 2026-11-10, Fragen 3–5).
   */
  @Column({ name: 'is_employee', type: 'boolean', default: false })
  isEmployee: boolean;

  /** Dieselbe Person ist auch Mitglied (optional). */
  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  /** Herkunft aus der Schichtplanung (P5); der Helfer-Loeschlauf leert sie. */
  @Column({
    name: 'source_registration_group_id',
    type: 'uuid',
    nullable: true,
  })
  sourceRegistrationGroupId: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({
    name: 'last_used_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  lastUsedAt: Date | null;

  /** Seit wann deaktiviert (Frist des Loeschlaufs `waiter_data`). */
  @Column({
    name: 'deactivated_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  deactivatedAt: Date | null;

  @Column({
    name: 'anonymized_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  anonymizedAt: Date | null;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId: string | null;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization?: Organization;

  @ManyToOne(() => Event, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'event_id' })
  event?: Event | null;
}
