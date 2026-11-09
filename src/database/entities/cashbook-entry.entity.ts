import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from './base.entity';

/**
 * - `opening_balance`: Anfangsbestand (Wechselgeld) — GV „Anfangsbestand“
 * - `deposit`: Einlage (Geld aus Vereinskasse/Tresor/Bank) — GV „Geldtransit“
 * - `withdrawal`: Entnahme/Abschoepfung (in Tresor/Bank) — GV „Geldtransit“
 * - `cash_count`: Kassensturz (gezaehlt); Abweichung → GV „DifferenzSollIst“
 */
export const CASHBOOK_TYPES = [
  'opening_balance',
  'deposit',
  'withdrawal',
  'cash_count',
] as const;
export type CashbookType = (typeof CASHBOOK_TYPES)[number];

/** `device`: Kasse eines Geraets (Schublade); `register`: ganze Kasse. */
export type CashbookScope = 'device' | 'register';

/**
 * Kassenbuch-Eintrag je Geschaeftstag. `amount` ist die Bargeldbewegung
 * (Entnahme negativ; beim Kassensturz die Differenz gezaehlt − Soll). Jede
 * Bewegung ungleich 0 ist ein eigener, TSE-gesicherter Beleg
 * (`tse_transaction_id`, Kassenbeleg-V1).
 */
@Entity('cashbook_entries')
@Index('IDX_cashbook_entries_org_date', [
  'organizationId',
  'businessDate',
  'createdAt',
])
export class CashbookEntry extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'business_date', type: 'date' })
  businessDate: string;

  @Column({ type: 'varchar', length: 20 })
  type: CashbookType;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  amount: string;

  @Column({
    name: 'counted_amount',
    type: 'decimal',
    precision: 12,
    scale: 2,
    nullable: true,
  })
  countedAmount: string | null;

  @Column({
    name: 'expected_amount',
    type: 'decimal',
    precision: 12,
    scale: 2,
    nullable: true,
  })
  expectedAmount: string | null;

  @Column({ type: 'varchar', length: 20, default: 'device' })
  scope: CashbookScope;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note: string | null;

  @Column({ name: 'device_id', type: 'uuid', nullable: true })
  deviceId: string | null;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  /** Buchende Bedienung (Sitzung an der Kasse). */
  @Column({ name: 'waiter_id', type: 'uuid', nullable: true })
  waiterId: string | null;

  @Column({ name: 'tse_transaction_id', type: 'uuid', nullable: true })
  tseTransactionId: string | null;
}
