import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { TseUnit } from './tse-unit.entity';

/**
 * Art des abgesicherten Vorgangs:
 * - `receipt`: Kassenbeleg einer Zahlung (Kassenbeleg-V1, Beleg)
 * - `refund`: Gegenbeleg einer Erstattung (negativ, Verweis auf das Original)
 * - `deposit_return`: Pfand-Auszahlung (negativ)
 * - `order`: Bestellvorgang im Tischbetrieb (Bestellung-V1)
 * - `order_cancellation`: Storno von Bestellpositionen (Bestellung-V1, negative Mengen)
 * - `abort`: Abschluss einer haengengebliebenen Transaktion (AVBelegabbruch)
 * - `cashbook`: Kassenbuch (Anfangsbestand, Einlage, Entnahme, Kassensturz-Differenz)
 */
export type TseTransactionKind =
  | 'receipt'
  | 'refund'
  | 'deposit_return'
  | 'order'
  | 'order_cancellation'
  | 'abort'
  | 'cashbook';

/**
 * - `pending`: Anfrage an die TSE laeuft (oder Prozess brach ab)
 * - `signed`: von der TSE abgesichert
 * - `training`: als Trainingsbuchung abgesichert (AVTraining, Testmodus)
 * - `failed`: nicht abgesichert (TSE-Ausfall), Bon mit Vermerk
 */
export type TseTransactionStatus = 'pending' | 'signed' | 'training' | 'failed';

/**
 * Ein Vorgang, der ueber die Cloud-TSE abgesichert wurde (oder werden
 * sollte). Unveraenderlich nach Abschluss; wird **nie** geloescht
 * (Aufbewahrung, auch Trainingsbuchungen). Bewusst ohne Fremdschluessel
 * auf Bestellungen/Zahlungen: das Aufraeumen von Testbestellungen darf
 * die abgesicherten Daten nicht mitnehmen — `lines` haelt deshalb eine
 * Kopie der Positionen und Betraege.
 */
@Entity('tse_transactions')
@Index('IDX_tse_transactions_org_created', ['organizationId', 'createdAt'])
@Index('IDX_tse_transactions_order', ['orderId'])
@Index('IDX_tse_transactions_payment', ['paymentId'])
@Index('IDX_tse_transactions_refund', ['refundId'])
@Index('IDX_tse_transactions_pfand_return', ['pfandReturnId'])
@Index('IDX_tse_transactions_unit_number', ['tseUnitId', 'transactionNumber'])
export class TseTransaction extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'tse_unit_id', type: 'uuid', nullable: true })
  tseUnitId: string | null;

  @ManyToOne(() => TseUnit, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'tse_unit_id' })
  tseUnit?: TseUnit | null;

  @Column({ name: 'event_id', type: 'uuid', nullable: true })
  eventId: string | null;

  @Column({ type: 'varchar', length: 30 })
  kind: TseTransactionKind;

  @Column({ name: 'process_type', type: 'varchar', length: 40 })
  processType: string;

  /** Klartext (vor Base64), z. B. `Beleg^1.19_0.00_0.00_0.00_0.00^1.19:Bar`. */
  @Column({ name: 'process_data', type: 'text' })
  processData: string;

  @Column({ type: 'boolean', default: false })
  training: boolean;

  @Column({ type: 'varchar', length: 20 })
  status: TseTransactionStatus;

  @Column({ name: 'client_id', type: 'varchar', length: 30 })
  clientId: string;

  /** Seriennummer der TSE zum Zeitpunkt des Vorgangs. */
  @Column({
    name: 'serial_number',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  serialNumber: string | null;

  @Column({ name: 'transaction_number', type: 'bigint', nullable: true })
  transactionNumber: string | null;

  @Column({ name: 'signature_counter', type: 'bigint', nullable: true })
  signatureCounter: string | null;

  /** Log-Zeit von startTransaction. */
  @Column({
    name: 'start_time',
    type: 'timestamp with time zone',
    nullable: true,
  })
  startTime: Date | null;

  /** Log-Zeit von finishTransaction. */
  @Column({
    name: 'finish_time',
    type: 'timestamp with time zone',
    nullable: true,
  })
  finishTime: Date | null;

  @Column({ name: 'signature_value', type: 'text', nullable: true })
  signatureValue: string | null;

  /** Bruttobetrag des Vorgangs (negativ bei Erstattung/Pfand). */
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  amount: string | null;

  /** Kopie der Positionen/Betraege fuer DSFinV-K (bleibt auch ohne Bestellung). */
  @Column({ type: 'jsonb', nullable: true })
  lines: Record<string, unknown> | null;

  @Column({ name: 'error_code', type: 'varchar', length: 60, nullable: true })
  errorCode: string | null;

  @Column({
    name: 'error_message',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  errorMessage: string | null;

  /** Haengende Transaktion per AVBelegabbruch geschlossen. */
  @Column({
    name: 'aborted_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  abortedAt: Date | null;

  /** Signatur nachtraeglich per Abgleich gefunden (Bon trug Ausfallvermerk). */
  @Column({
    name: 'recovered_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  recoveredAt: Date | null;

  /** Eingabegeraet (Terminal) = Geraete-ID. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  terminal: string | null;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  /** Bedienung (BEDIENER_ID der DSFinV-K, vor `userId`). */
  @Column({ name: 'waiter_id', type: 'uuid', nullable: true })
  waiterId: string | null;

  /**
   * Name des Bedieners beim Signieren (BEDIENER_NAME, hoechstens 50
   * Zeichen). Snapshot fuer das Steuerarchiv: bleibt, auch wenn die
   * Bedienung spaeter anonymisiert oder das Mitglied entfernt wird.
   */
  @Column({
    name: 'operator_name',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  operatorName: string | null;

  @Column({ name: 'order_id', type: 'uuid', nullable: true })
  orderId: string | null;

  @Column({ name: 'payment_id', type: 'uuid', nullable: true })
  paymentId: string | null;

  @Column({ name: 'refund_id', type: 'uuid', nullable: true })
  refundId: string | null;

  @Column({ name: 'pfand_return_id', type: 'uuid', nullable: true })
  pfandReturnId: string | null;

  @Column({
    name: 'references_tse_transaction_id',
    type: 'uuid',
    nullable: true,
  })
  referencesTseTransactionId: string | null;

  @Column({
    name: 'start_request_id',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  startRequestId: string | null;

  @Column({
    name: 'finish_request_id',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  finishRequestId: string | null;

  @Column({ name: 'duration_ms', type: 'int', nullable: true })
  durationMs: number | null;

  /**
   * BON_ID/BON_NR der DSFinV-K: fortlaufend je Kasse (Organisation), vom
   * Datenbank-Trigger beim Einfuegen vergeben (Migration 1836…).
   */
  @Column({
    name: 'bon_id',
    type: 'bigint',
    nullable: true,
    insert: false,
    update: false,
  })
  bonId: string | null;

  /** Kassenabschluss, in dem der Vorgang steht (null = noch offen). */
  @Column({ name: 'cash_point_closing_id', type: 'uuid', nullable: true })
  cashPointClosingId: string | null;
}
