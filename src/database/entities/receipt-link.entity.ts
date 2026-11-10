import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from 'typeorm';

/**
 * Link auf einen digitalen Beleg (QR-Code an der Kasse, Link in der
 * Beleg-Mail). Gespeichert wird nur der SHA-256 des Tokens: Der Token selbst
 * (128 Bit Zufall) steht nur im QR-Code bzw. in der Mail. Wer die Tabelle
 * liest, kann damit keinen Beleg oeffnen.
 *
 * Der Link verweist auf Bestellungen; der Beleg selbst wird bei jedem Aufruf
 * aus den Kassendaten erzeugt (dieselben Daten wie der gedruckte Bon). Nach
 * `expires_at` ist der Link tot; der Loeschlauf `receipt_links` entfernt
 * ihn. Personenbezogene Daten stehen hier nicht.
 */
@Entity('receipt_links')
export class ReceiptLink {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  /** SHA-256 (hex) des Tokens. */
  @Column({ name: 'token_hash', type: 'char', length: 64 })
  tokenHash: string;

  @Column({ name: 'order_ids', type: 'uuid', array: true })
  orderIds: string[];

  /** `receipt` (Kassenbeleg) oder `hospitality` (Bewirtungsbeleg). */
  @Column({ type: 'varchar', length: 20, default: 'receipt' })
  kind: 'receipt' | 'hospitality';

  @Column({ name: 'hospitality_receipt_id', type: 'uuid', nullable: true })
  hospitalityReceiptId: string | null;

  /** Ausgabe als „Kopie“ (Bewirtungsbeleg schon einmal ausgegeben). */
  @Column({ type: 'boolean', default: false })
  copy: boolean;

  @Column({ name: 'created_by_device_id', type: 'uuid', nullable: true })
  createdByDeviceId: string | null;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId: string | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
