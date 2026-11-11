import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import type { TokenKind } from './token-type.entity';

export const TOKEN_TRANSACTION_KINDS = ['sale', 'buyback'] as const;
export type TokenTransactionKind = (typeof TOKEN_TRANSACTION_KINDS)[number];

/** Position eines Verkaufs/Ruecktauschs (Schnappschuss des Markentyps). */
export interface TokenTransactionLine {
  tokenTypeId: string;
  name: string;
  kind: TokenKind;
  /** Nennwert je Marke in Euro. */
  unitValue: number;
  count: number;
  /** count × unitValue in Euro (Ruecktausch negativ). */
  amount: number;
  /** Satz bei Einzweckgutschein, sonst null (nicht steuerbar). */
  vatRate: number | null;
}

/** MwSt-Zeile (nur Einzweckgutscheine), wie auf dem Beleg. */
export interface TokenTransactionTaxLine {
  rate: number;
  gross: number;
  net: number;
  tax: number;
}

/**
 * Verkauf (`sale`, Geld rein) bzw. Ruecktausch (`buyback`, Bargeld raus) von
 * Wertmarken an der Kasse. Unveraenderlich (Trigger); jede Buchung ist mit
 * Cloud-TSE ein eigener Kassenbeleg (`tse_transactions.token_transaction_id`).
 * Belegnummer `W-JJJJMMTT-NNNN` je Organisation und Tag.
 */
@Entity('token_transactions')
@Index('IDX_token_transactions_org_created', ['organizationId', 'createdAt'])
@Index('IDX_token_transactions_event', ['eventId'])
export class TokenTransaction extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'event_id', type: 'uuid', nullable: true })
  eventId: string | null;

  @Column({ type: 'varchar', length: 20 })
  kind: TokenTransactionKind;

  @Column({ name: 'transaction_number', type: 'varchar', length: 50 })
  transactionNumber: string;

  @Column({ type: 'jsonb', default: [] })
  lines: TokenTransactionLine[];

  /** Summe in Euro: Verkauf positiv, Ruecktausch negativ. */
  @Column({ name: 'total_amount', type: 'decimal', precision: 10, scale: 2 })
  totalAmount: number;

  @Column({ name: 'tax_lines', type: 'jsonb', default: [] })
  taxLines: TokenTransactionTaxLine[];

  /** `cash`, `card`, `sumup_terminal` (Ruecktausch immer `cash`). */
  @Column({ name: 'payment_method', type: 'varchar', length: 20 })
  paymentMethod: string;

  @Column({
    name: 'provider_transaction_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  providerTransactionId: string | null;

  /** Bei Barverkauf: vom Gast erhalten (fuer das Rueckgeld auf dem Beleg). */
  @Column({
    name: 'amount_received',
    type: 'decimal',
    precision: 10,
    scale: 2,
    nullable: true,
  })
  amountReceived: number | null;

  @Column({ name: 'device_id', type: 'uuid', nullable: true })
  deviceId: string | null;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ name: 'waiter_id', type: 'uuid', nullable: true })
  waiterId: string | null;

  @Column({ name: 'actor_name', type: 'varchar', length: 255, nullable: true })
  actorName: string | null;

  /** Ruecktausch: Grund/Notiz. */
  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ name: 'is_test', type: 'boolean', default: false })
  isTest: boolean;

  @Column({ name: 'client_request_id', type: 'uuid', nullable: true })
  clientRequestId: string | null;

  @Column({ type: 'jsonb', default: {} })
  metadata: Record<string, unknown>;
}
