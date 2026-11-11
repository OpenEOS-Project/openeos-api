import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';

/**
 * Art der Wertmarke (Steuerberater 2026-11-10, Frage 13):
 * - `multi_purpose` — Mehrzweckgutschein (§ 3 Abs. 15 UStG, Standard):
 *   fuer Waren mit verschiedenen Steuersaetzen einloesbar (7 % Speisen,
 *   19 % Getraenke). Der Verkauf ist nicht steuerbar, die Umsatzsteuer
 *   entsteht bei der Einloesung mit dem Satz der Ware.
 * - `single_purpose` — Einzweckgutschein (§ 3 Abs. 14 UStG): nur fuer
 *   Artikel mit genau einem Satz (z. B. „Getraenkemarke“ nur fuer 19 %).
 *   Versteuert beim Verkauf mit diesem Satz, die Einloesung ist dann ohne
 *   Umsatzsteuer.
 */
export const TOKEN_KINDS = ['multi_purpose', 'single_purpose'] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

/**
 * Markentyp einer Organisation (z. B. „2-€-Marke“, „Getränkemarke“).
 * Wertmarken sind physisch (Papier/Plastik); OpenEOS zaehlt Ausgabe,
 * Einloesung und Ruecktausch je Typ. `eventId` leer = fuer alle
 * Veranstaltungen der Organisation.
 */
@Entity('token_types')
@Index('IDX_token_types_org', ['organizationId', 'isActive'])
export class TokenType extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'event_id', type: 'uuid', nullable: true })
  eventId: string | null;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  /** Nennwert in Euro (Verkaufspreis = Einloesewert). */
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  value: number;

  @Column({ type: 'varchar', length: 20, default: 'multi_purpose' })
  kind: TokenKind;

  /** Steuersatz eines Einzweckgutscheins (Satz aller zugeordneten Artikel). */
  @Column({
    name: 'vat_rate',
    type: 'decimal',
    precision: 5,
    scale: 2,
    nullable: true,
  })
  vatRate: number | null;

  /** Nur fuer Artikel dieser Kategorien einloesbar (leer = keine Beschraenkung). */
  @Column({
    name: 'allowed_category_ids',
    type: 'uuid',
    array: true,
    default: () => "'{}'",
  })
  allowedCategoryIds: string[];

  /** Nur fuer diese Artikel einloesbar (zusaetzlich zu den Kategorien). */
  @Column({
    name: 'allowed_product_ids',
    type: 'uuid',
    array: true,
    default: () => "'{}'",
  })
  allowedProductIds: string[];

  /** Farbe als #rrggbb (Kasse, Bogen). */
  @Column({ type: 'varchar', length: 7, nullable: true })
  color: string | null;

  /**
   * Ruecktausch gegen Bargeld an der Kasse erlaubt. Standard aus: ein
   * voraussetzungsloser Ruecktausch jederzeit macht die Marke zur
   * Guthabenkarte (Steuerberater 2026-11-10, Frage 13).
   */
  @Column({ name: 'buyback_allowed', type: 'boolean', default: false })
  buybackAllowed: boolean;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization?: Organization;
}
