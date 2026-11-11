import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { numericTransformer } from '../transformers/numeric.transformer';

/** Anzahl und Summe einer Kennzahl der Kellnerabrechnung. */
export interface SettlementCount {
  count: number;
  amount: number;
}

/**
 * Schnappschuss der Zahlen einer Kellnerabrechnung (bedienungen-plan.md
 * §7). In der Betriebsart „Nur Bons“ (`orders_only`) fehlen alle Betraege,
 * es bleiben die Mengen unter `taken`.
 */
export interface SettlementTotals {
  operatingMode: 'full' | 'cashless' | 'orders_only';
  /** Kassiert je Zahlart (bar, Karte, sonstige), davon Trinkgeld. */
  payments?: {
    cash: SettlementCount;
    card: SettlementCount;
    other: SettlementCount;
    total: SettlementCount;
  };
  tips?: number;
  /** Erstattungen/Storno, die die Person ausgeloest hat (Betraege positiv). */
  refunds?: {
    cash: SettlementCount;
    nonCash: SettlementCount;
    total: SettlementCount;
  };
  /** Pfand-Auszahlungen (bar). */
  pfandReturns?: SettlementCount;
  /**
   * Wertmarken: angenommen (eingeloest, die Person gibt sie ab wie Bargeld)
   * je Typ, verkauft (bar/Karte) und zurueckgetauscht (bar). Angenommene
   * Marken sind kein Bargeld — sie stehen nicht in „Soll bar“.
   */
  tokens?: {
    received: SettlementCount;
    receivedByType: {
      tokenTypeId: string;
      name: string;
      unitValue: number;
      count: number;
      amount: number;
    }[];
    sold: SettlementCount;
    soldCash: number;
    boughtBack: SettlementCount;
  };
  /** Aufgenommen (informativ): Bestellungen, Positionen, Umsatz, Rabatte. */
  taken: {
    orders: number;
    items: number;
    revenue?: number;
    discounts?: number;
  };
  /**
   * Soll bar = Barzahlungen − Bar-Erstattungen − Pfand-Auszahlungen
   * + Wertmarken bar verkauft − Wertmarken-Ruecktausch (ohne
   * Kellnerbrieftasche nur informativ: das Geld liegt in der Schublade).
   */
  cashExpected?: number;
  /** Wo das Bargeld liegt: Schublade je Geraet. */
  cashByDevice?: {
    deviceId: string | null;
    deviceName: string | null;
    amount: number;
  }[];
  /** Testbuchungen („Training“): nie im Geld. */
  training: {
    orders: number;
    payments: number;
    amount?: number;
  };
}

export interface SettlementOpenTable {
  orderId: string;
  orderNumber: string;
  dailyNumber: number | null;
  tableNumber: string | null;
  openAmount?: number;
}

/**
 * Kellnerabrechnung (Schichtende je Bedienung bzw. Mitglied), unveraenderlich
 * per Trigger `waiter_settlements_immutable` (nur `printedAt` darf sich
 * aendern). Korrektur nur ueber eine weitere Abrechnung. Personen-IDs sind
 * Schnappschuesse ohne Fremdschluessel.
 */
@Entity('waiter_settlements')
@Index('IDX_waiter_settlements_org_event', [
  'organizationId',
  'eventId',
  'createdAt',
])
export class WaiterSettlement extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  /** Fortlaufend je Organisation; Trainings-Abrechnungen haben keine. */
  @Column({ type: 'int', nullable: true })
  number: number | null;

  /** Nur Testbuchungen (Training): ohne Nummer, beim Aktivieren geloescht. */
  @Column({ name: 'is_test', type: 'boolean', default: false })
  isTest: boolean;

  @Column({ name: 'waiter_id', type: 'uuid', nullable: true })
  waiterId: string | null;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ name: 'event_id', type: 'uuid', nullable: true })
  eventId: string | null;

  @Column({
    name: 'period_from',
    type: 'timestamp with time zone',
    nullable: true,
  })
  periodFrom: Date | null;

  @Column({ name: 'period_to', type: 'timestamp with time zone' })
  periodTo: Date;

  @Column({ type: 'jsonb', default: {} })
  totals: SettlementTotals;

  @Column({
    name: 'opening_float',
    type: 'decimal',
    precision: 12,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  openingFloat: number;

  @Column({
    name: 'cash_expected',
    type: 'decimal',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  cashExpected: number | null;

  @Column({
    name: 'cash_counted',
    type: 'decimal',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  cashCounted: number | null;

  @Column({
    type: 'decimal',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  difference: number | null;

  /** Kellnerbrieftasche (erst nach Antwort des Steuerberaters; bis dahin false). */
  @Column({ type: 'boolean', default: false })
  wallet: boolean;

  @Column({ name: 'open_tables', type: 'jsonb', default: [] })
  openTables: SettlementOpenTable[];

  /** Trotz offener Tische abgerechnet (Schichtleitung/Admin, mit Notiz). */
  @Column({ type: 'boolean', default: false })
  forced: boolean;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note: string | null;

  @Column({ name: 'settled_by_user_id', type: 'uuid', nullable: true })
  settledByUserId: string | null;

  @Column({ name: 'settled_by_waiter_id', type: 'uuid', nullable: true })
  settledByWaiterId: string | null;

  @Column({ name: 'device_id', type: 'uuid', nullable: true })
  deviceId: string | null;

  @Column({
    name: 'cashbook_entry_ids',
    type: 'uuid',
    array: true,
    default: () => "'{}'",
  })
  cashbookEntryIds: string[];

  @Column({
    name: 'printed_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  printedAt: Date | null;
}
