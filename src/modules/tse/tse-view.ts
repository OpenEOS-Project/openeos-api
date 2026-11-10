import type { TseTransaction } from '../../database/entities/tse-transaction.entity';
import type { TseUnit } from '../../database/entities/tse-unit.entity';
import { qrCodePayload } from './tse-process-data';

/**
 * Hinweis auf Bon und Beleg bei Ausfall (AEAO zu § 146a Nr. 1.14.2:
 * „eindeutige Kennzeichnung“). Gilt auch, wenn die Signatur erst nach der
 * Belegausgabe eintrifft — der Bon bleibt ein Ausfallbeleg.
 */
export const TSE_FAILED_NOTICE = 'TSE nicht erreichbar – Beleg ohne Signatur';
/**
 * Kennzeichnung einer Signatur, die erst nach der Belegausgabe eintraf
 * (Abgleich, verlorene Antwort). DSFinV-K: `TSE_TA_FEHLER`.
 */
export const TSE_LATE_SIGNATURE_NOTE = 'Signatur nach Belegausgabe';
/** Hinweis bei Trainingsbuchungen (Testmodus, DSFinV-K AVTraining). */
export const TSE_TRAINING_NOTICE = 'TRAININGSBUCHUNG – KEIN VERKAUF';

/**
 * TSE-Daten eines Vorgangs fuer API-Antworten (Kasse, Verwaltung,
 * digitaler Beleg). Vertrag: tse-swissbit-plan.md §8.
 */
export interface TseReceiptView {
  id: string;
  kind: TseTransaction['kind'];
  status: TseTransaction['status'];
  training: boolean;
  /**
   * `TSE nicht erreichbar – Beleg ohne Signatur` (failed/pending),
   * `TRAININGSBUCHUNG – KEIN VERKAUF` oder null.
   */
  notice: string | null;
  processType: string;
  processData: string;
  serialNumber: string | null;
  clientId: string;
  transactionNumber: number | null;
  signatureCounter: number | null;
  /** ISO 8601 UTC, wie von der TSE (Log-Zeit). */
  startTime: string | null;
  finishTime: string | null;
  signatureValue: string | null;
  signatureAlgorithm: string | null;
  logTimeFormat: string | null;
  publicKey: string | null;
  /** QR-Code-Inhalt nach DSFinV-K Anhang I (V0); null wenn nicht signiert. */
  qrCode: string | null;
  errorCode: string | null;
  terminal: string | null;
  /** Bezug des Vorgangs (null, wenn nicht zutreffend). */
  orderId: string | null;
  paymentId: string | null;
  refundId: string | null;
  pfandReturnId: string | null;
  /**
   * Beleg-Nr. der Kasse (DSFinV-K BON_ID/BON_NR), fortlaufend je
   * Organisation; null, solange die Datenbank sie noch nicht vergeben hat.
   */
  bonNumber: number | null;
  /**
   * Signatur, die erst nach der Belegausgabe eintraf (der Abgleich hat eine
   * verlorene Antwort gefunden). Der Vorgang bleibt `failed`, der Beleg ein
   * Ausfallbeleg; die Daten stehen nur zur Nachvollziehbarkeit hier.
   */
  lateSignature: {
    note: string;
    transactionNumber: number | null;
    signatureCounter: number | null;
    finishTime: string | null;
    recoveredAt: string | null;
  } | null;
  /**
   * Beginn der ersten abgesicherten Bestellung (Bestellung-V1) zu diesem
   * Beleg, ISO 8601 UTC wie von der TSE; muss auf den Beleg (DSFinV-K Tz.
   * 2.7.3). null ohne Bestellvorgang.
   */
  orderStartTime?: string | null;
  createdAt: string;
}

/** Was die Ansicht von der TSE braucht (aus `tse_units`). */
export type TseUnitInfo = Pick<
  TseUnit,
  'serialNumber' | 'publicKey' | 'signatureAlgorithm' | 'logTimeFormat'
>;

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

export function tseReceiptView(
  tx: TseTransaction,
  unit: TseUnitInfo | null,
): TseReceiptView {
  const signed = tx.status === 'signed' || tx.status === 'training';
  const startTime = iso(tx.startTime);
  const finishTime = iso(tx.finishTime);
  const signatureAlgorithm = unit?.signatureAlgorithm ?? null;
  const logTimeFormat = unit?.logTimeFormat ?? null;
  const publicKey = unit?.publicKey ?? null;
  const transactionNumber = toNumber(tx.transactionNumber);
  // Unsigniert ausgegeben: Zaehler und Ende so, wie sie beim Druck bekannt
  // waren (nicht) — eine spaetere Signatur steht nur in `lateSignature`.
  const signatureCounter = signed ? toNumber(tx.signatureCounter) : null;
  const late =
    !signed && tx.recoveredAt && tx.signatureValue
      ? {
          note: TSE_LATE_SIGNATURE_NOTE,
          transactionNumber,
          signatureCounter: toNumber(tx.signatureCounter),
          finishTime,
          recoveredAt: iso(tx.recoveredAt),
        }
      : null;
  const qrCode =
    signed &&
    startTime &&
    finishTime &&
    tx.signatureValue &&
    signatureAlgorithm &&
    logTimeFormat &&
    publicKey &&
    transactionNumber !== null &&
    signatureCounter !== null
      ? qrCodePayload({
          clientId: tx.clientId,
          processType: tx.processType,
          processData: tx.processData,
          transactionNumber,
          signatureCounter,
          startTime,
          finishTime,
          signatureAlgorithm,
          logTimeFormat,
          signatureValue: tx.signatureValue,
          publicKey,
        })
      : null;
  return {
    id: tx.id,
    kind: tx.kind,
    status: tx.status,
    training: tx.training,
    notice: !signed
      ? TSE_FAILED_NOTICE
      : tx.training
        ? TSE_TRAINING_NOTICE
        : null,
    processType: tx.processType,
    processData: tx.processData,
    serialNumber: tx.serialNumber ?? unit?.serialNumber ?? null,
    clientId: tx.clientId,
    transactionNumber,
    signatureCounter,
    startTime,
    finishTime: signed ? finishTime : null,
    signatureValue: signed ? tx.signatureValue : null,
    signatureAlgorithm,
    logTimeFormat,
    publicKey,
    qrCode,
    errorCode: signed ? null : tx.errorCode,
    terminal: tx.terminal,
    orderId: tx.orderId ?? null,
    paymentId: tx.paymentId ?? null,
    refundId: tx.refundId ?? null,
    pfandReturnId: tx.pfandReturnId ?? null,
    bonNumber: toNumber(tx.bonId),
    lateSignature: late,
    createdAt: iso(tx.createdAt) ?? new Date().toISOString(),
  };
}

/**
 * `tse`-Block im Druckauftrag (snake_case wie der restliche Payload). Der
 * Drucker-Agent druckt bei `failed` den Vermerk statt der Signatur und
 * rendert `qr_code` als QR (Fehlerkorrektur Q, >= 3 cm).
 */
export interface TsePrintBlock {
  status: TseReceiptView['status'];
  failed: boolean;
  training: boolean;
  notice: string | null;
  process_type: string;
  serial_number: string | null;
  client_id: string;
  /** Beleg-Nr. (DSFinV-K BON_NR), null bei aelteren Vorgaengen. */
  bon_number: number | null;
  transaction_number: number | null;
  signature_counter: number | null;
  start_time: string | null;
  finish_time: string | null;
  signature: string | null;
  signature_algorithm: string | null;
  log_time_format: string | null;
  public_key: string | null;
  qr_code: string | null;
  /**
   * Nur beim Nachdruck eines Ausfallbelegs, dessen Signatur spaeter eintraf:
   * gekennzeichnet „Signatur nach Belegausgabe“, ohne QR-Code (der Beleg
   * bleibt ein Ausfallbeleg). Beim ersten Druck immer null.
   */
  late_signature: {
    note: string;
    transaction_number: number | null;
    signature_counter: number | null;
    finish_time: string | null;
  } | null;
  /** Beginn der ersten Bestellung (Bestellung-V1), DSFinV-K Tz. 2.7.3. */
  order_start_time: string | null;
}

export function tsePrintBlock(
  view: TseReceiptView | null | undefined,
  options: { reprint?: boolean } = {},
): TsePrintBlock | null {
  if (!view) return null;
  const late = options.reprint ? view.lateSignature : null;
  return {
    status: view.status,
    failed: view.status === 'failed' || view.status === 'pending',
    training: view.training,
    notice: view.notice,
    process_type: view.processType,
    serial_number: view.serialNumber,
    client_id: view.clientId,
    bon_number: view.bonNumber ?? null,
    transaction_number: view.transactionNumber,
    signature_counter: view.signatureCounter,
    start_time: view.startTime,
    finish_time: view.finishTime,
    signature: view.signatureValue,
    signature_algorithm: view.signatureAlgorithm,
    log_time_format: view.logTimeFormat,
    public_key: view.publicKey,
    qr_code: view.qrCode,
    late_signature: late
      ? {
          note: late.note,
          transaction_number: late.transactionNumber,
          signature_counter: late.signatureCounter,
          finish_time: late.finishTime,
        }
      : null,
    order_start_time: view.orderStartTime ?? null,
  };
}
