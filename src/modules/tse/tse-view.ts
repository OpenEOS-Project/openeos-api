import type { TseTransaction } from '../../database/entities/tse-transaction.entity';
import type { TseUnit } from '../../database/entities/tse-unit.entity';
import { qrCodePayload } from './tse-process-data';

/** Hinweis auf Bon und Beleg bei Ausfall (AEAO zu § 146a Nr. 1.14). */
export const TSE_FAILED_NOTICE = 'TSE ausgefallen';
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
  /** `TSE ausgefallen`, `TRAININGSBUCHUNG – KEIN VERKAUF` oder null. */
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
  const signatureCounter = toNumber(tx.signatureCounter);
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
    finishTime,
    signatureValue: signed ? tx.signatureValue : null,
    signatureAlgorithm,
    logTimeFormat,
    publicKey,
    qrCode,
    errorCode: signed ? null : tx.errorCode,
    terminal: tx.terminal,
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
  transaction_number: number | null;
  signature_counter: number | null;
  start_time: string | null;
  finish_time: string | null;
  signature: string | null;
  signature_algorithm: string | null;
  log_time_format: string | null;
  public_key: string | null;
  qr_code: string | null;
}

export function tsePrintBlock(
  view: TseReceiptView | null | undefined,
): TsePrintBlock | null {
  if (!view) return null;
  return {
    status: view.status,
    failed: view.status === 'failed' || view.status === 'pending',
    training: view.training,
    notice: view.notice,
    process_type: view.processType,
    serial_number: view.serialNumber,
    client_id: view.clientId,
    transaction_number: view.transactionNumber,
    signature_counter: view.signatureCounter,
    start_time: view.startTime,
    finish_time: view.finishTime,
    signature: view.signatureValue,
    signature_algorithm: view.signatureAlgorithm,
    log_time_format: view.logTimeFormat,
    public_key: view.publicKey,
    qr_code: view.qrCode,
  };
}
