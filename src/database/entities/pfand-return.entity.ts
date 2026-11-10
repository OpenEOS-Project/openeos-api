import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';

export interface PfandReturnLine {
  pfandTypeId: string;
  name: string;
  /** Deposit amount per unit at the time of the return. */
  unitAmount: number;
  quantity: number;
  /**
   * Umsatzsteuersatz der Pfandart bei der Rueckgabe. Fehlt bei Auszahlungen
   * von vor der Umstellung (2026-11): die galten als nicht steuerbar (0 %).
   */
  vatRate?: number;
  /**
   * Anteil (Cent), der gegen den Pfand-Altsaldo gebucht wurde: Becher, die
   * vor der Umstellung ohne USt verkauft wurden, mindern bei Rueckgabe keine
   * Steuer (USt-Schluessel 5). Steuerberater 2026-11-10, Frage 2.
   */
  legacyCents?: number;
}

/** MwSt-Zeile einer Auszahlung (Betraege negativ), wie auf dem Bon. */
export interface PfandReturnTaxLine {
  rate: number;
  gross: number;
  net: number;
  tax: number;
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

  /** Auszahlende Bedienung (Sitzung an der Kasse). */
  @Column({ name: 'waiter_id', type: 'uuid', nullable: true })
  waiterId: string | null;

  /** Total amount paid back to the guest, in EUR. */
  @Column({ name: 'total_amount', type: 'decimal', precision: 10, scale: 2 })
  totalAmount: number;

  @Column({ type: 'jsonb', default: [] })
  lines: PfandReturnLine[];

  /** Belegnummer `P-JJJJMMTT-NNNN`; NULL bei Auszahlungen von vor 2026-11. */
  @Column({
    name: 'return_number',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  returnNumber: string | null;

  /** MwSt je Satz (negativ); leer bei steuerbefreiten Organisationen und im Bestand. */
  @Column({ name: 'tax_lines', type: 'jsonb', default: [] })
  taxLines: PfandReturnTaxLine[];

  /** Im Testmodus gebucht; wird beim Aktivieren der Veranstaltung geloescht. */
  @Column({ name: 'is_test', type: 'boolean', default: false })
  isTest: boolean;

  // Relations
  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;
}
