import {
  Entity,
  Column,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';
import { BaseEntity } from './base.entity';
import { Order } from './order.entity';
import { Payment, PaymentMethod } from './payment.entity';
import { Device } from './device.entity';
import { User } from './user.entity';
import { numericTransformer } from '../transformers/numeric.transformer';

/**
 * `cancellation`: Positionen wurden storniert, die Summe der Bestellung ist
 * dadurch gesunken (die Erstattung gibt das zu viel Bezahlte zurueck).
 * `refund`: Erstattung ohne Storno (Kulanz, Betrag oder Positionen, die
 * geliefert bleiben) — die Bestellsumme bleibt, der Umsatz sinkt um die
 * Erstattung.
 */
export const REFUND_KINDS = ['cancellation', 'refund'] as const;
export type RefundKind = (typeof REFUND_KINDS)[number];

/**
 * `completed`: Geld ist zurueck (bar ausgezahlt bzw. vom Anbieter bestaetigt).
 * `manual`: ausserhalb von OpenEOS erstattet (fremdes Kartengeraet, SumUp-
 * Fehler mit Bestaetigung „manuell erstattet“).
 * `test`: im Testmodus gebucht, beim Anbieter nichts ausgeloest.
 */
export const REFUND_STATUSES = ['completed', 'manual', 'test'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const REFUND_REASON_CODES = [
  'wrong_order',
  'quality',
  'not_delivered',
  'customer_request',
  'duplicate',
  'price_error',
  'other',
] as const;
export type RefundReasonCode = (typeof REFUND_REASON_CODES)[number];

/** Eine MwSt-Zeile des Gegenbelegs (alle Betraege negativ). */
export interface RefundTaxLine {
  rate: number;
  net: number;
  tax: number;
  gross: number;
}

/**
 * Erstattung = eigener Beleg (Gegenbeleg) mit negativen Betraegen und
 * Bezug auf die Ursprungsbestellung und -zahlung. Die Bestellung selbst
 * bleibt als Ursprungsbeleg erhalten (TSE-tauglich, vgl. fiskaly-spec
 * §Erstattung: eigener RECEIPT mit umgekehrten Vorzeichen).
 */
@Entity('refunds')
@Index(['orderId'])
@Index(['organizationId', 'createdAt'])
@Index(['paymentId'])
export class Refund extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  @Column({ name: 'payment_id', type: 'uuid', nullable: true })
  paymentId: string | null;

  @Column({ name: 'event_id', type: 'uuid', nullable: true })
  eventId: string | null;

  /** Belegnummer, z. B. `260512-0042-E1` (Bestellnummer + laufende Nummer). */
  @Column({ name: 'refund_number', type: 'varchar', length: 60 })
  refundNumber: string;

  @Column({ type: 'varchar', length: 20 })
  kind: RefundKind;

  /** Erstatteter Betrag, negativ (inkl. Pfand und Trinkgeld). */
  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: numericTransformer,
  })
  amount: number;

  @Column({
    name: 'tax_total',
    type: 'decimal',
    precision: 10,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  taxTotal: number;

  @Column({
    name: 'pfand_amount',
    type: 'decimal',
    precision: 10,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  pfandAmount: number;

  @Column({
    name: 'tip_amount',
    type: 'decimal',
    precision: 10,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  tipAmount: number;

  @Column({ name: 'tax_lines', type: 'jsonb', default: [] })
  taxLines: RefundTaxLine[];

  @Column({
    name: 'payment_method',
    type: 'enum',
    enum: PaymentMethod,
    enumName: 'payment_method',
  })
  paymentMethod: PaymentMethod;

  @Column({ type: 'varchar', length: 20 })
  status: RefundStatus;

  @Column({ type: 'varchar', length: 50 })
  provider: string;

  /** Transaktion beim Anbieter (SumUp: Transaktions-ID der Ursprungszahlung). */
  @Column({
    name: 'provider_reference',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  providerReference: string | null;

  @Column({ name: 'reason_code', type: 'varchar', length: 30 })
  reasonCode: RefundReasonCode;

  @Column({ name: 'reason_text', type: 'text', nullable: true })
  reasonText: string | null;

  @Column({ name: 'device_id', type: 'uuid', nullable: true })
  deviceId: string | null;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  /** Name des Bedieners zum Zeitpunkt der Erstattung (Anzeige, Bon). */
  @Column({ name: 'actor_name', type: 'varchar', length: 255, nullable: true })
  actorName: string | null;

  @Column({ name: 'is_test', type: 'boolean', default: false })
  isTest: boolean;

  @Column({ name: 'client_request_id', type: 'uuid', nullable: true })
  clientRequestId: string | null;

  @Column({ type: 'jsonb', default: {} })
  metadata: Record<string, unknown>;

  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @ManyToOne(() => Payment, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'payment_id' })
  payment: Payment | null;

  @ManyToOne(() => Device, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'device_id' })
  device: Device | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @OneToMany(() => RefundItem, (item) => item.refund, { cascade: true })
  items: RefundItem[];
}

/** Position eines Gegenbelegs (Betraege negativ, Menge positiv). */
@Entity('refund_items')
@Index(['refundId'])
export class RefundItem extends BaseEntity {
  @Column({ name: 'refund_id', type: 'uuid' })
  refundId: string;

  @Column({ name: 'order_item_id', type: 'uuid', nullable: true })
  orderItemId: string | null;

  @Column({ name: 'product_name', type: 'varchar', length: 255 })
  productName: string;

  @Column({ type: 'int' })
  quantity: number;

  /** Stueckpreis brutto inkl. Optionen, wie verkauft (positiv). */
  @Column({
    name: 'unit_price',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: numericTransformer,
  })
  unitPrice: number;

  @Column({
    name: 'tax_rate',
    type: 'decimal',
    precision: 5,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  taxRate: number;

  /** Erstatteter Warenwert (negativ, nach anteiligem Rabatt, ohne Pfand). */
  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: numericTransformer,
  })
  amount: number;

  @Column({
    name: 'deposit_amount',
    type: 'decimal',
    precision: 10,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  depositAmount: number;

  /** Position wurde mit der Erstattung storniert (nicht nur erstattet). */
  @Column({ type: 'boolean', default: false })
  cancelled: boolean;

  @ManyToOne(() => Refund, (refund) => refund.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'refund_id' })
  refund: Refund;
}
