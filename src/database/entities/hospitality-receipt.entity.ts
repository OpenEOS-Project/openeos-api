import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from 'typeorm';

/**
 * Ausgestellter Bewirtungsbeleg (siehe Migration 1841800000000). Nummer,
 * Jahr und laufende Nummer vergibt die Datenbank; der Datensatz ist
 * unveraenderlich (Trigger). `snapshot` haelt alles, was auf dem Beleg
 * steht, damit jeder Nachdruck (Kopie) genau gleich aussieht.
 */
@Entity('hospitality_receipts')
export class HospitalityReceipt {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ type: 'int', nullable: true })
  year: number | null;

  @Column({ type: 'int', nullable: true })
  sequence: number | null;

  /** `B-2026-0001`; null bei Testbelegen. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  number: string | null;

  @Column({ name: 'is_test', type: 'boolean', default: false })
  isTest: boolean;

  @Column({ name: 'issued_at', type: 'timestamptz' })
  issuedAt: Date;

  /** Tag der Bewirtung (JJJJ-MM-TT). */
  @Column({ name: 'service_date', type: 'date' })
  serviceDate: string;

  @Column({
    name: 'recipient_name',
    type: 'varchar',
    length: 200,
    nullable: true,
  })
  recipientName: string | null;

  @Column({
    name: 'recipient_address',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  recipientAddress: string | null;

  /** Rechnungsbetrag brutto (mit Trinkgeld, wie GESAMT auf dem Bon). */
  @Column({ type: 'decimal', precision: 12, scale: 2 })
  total: string;

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  tip: string;

  @Column({ type: 'jsonb' })
  snapshot: Record<string, unknown>;

  @Column({ name: 'device_id', type: 'uuid', nullable: true })
  deviceId: string | null;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ name: 'waiter_id', type: 'uuid', nullable: true })
  waiterId: string | null;

  @Column({ name: 'actor_name', type: 'varchar', length: 255, nullable: true })
  actorName: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
