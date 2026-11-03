/**
 * Typen und tolerante Parser fuer die Swissbit Cloud-TSE 2 (v1.1.1).
 *
 * Swissbit darf Antworten jederzeit um Felder erweitern (kein Breaking
 * Change laut SDK-Doku). Die Parser lesen deshalb nur, was wir brauchen,
 * und ignorieren den Rest. Fehlt ein Pflichtfeld, gibt es einen
 * `E_UNEXPECTED_RESPONSE`-Fehler statt `undefined` in der Datenbank.
 */

export type AsyncJobStatus = 'pending' | 'success' | 'failure';
export type CreditTokenState = 'active' | 'terminated';
export type TseHealthState = 'starting' | 'started' | 'stopped' | 'defect';
export type TseInitializationState =
  | 'uninitialized'
  | 'initialized'
  | 'disabled';
export type ProductTypeMode = 'unlimited' | 'topUp' | 'slowdown';

/** Basic-Auth fuer eine einzelne TSE (`tseSerialNumber` + `tseAccessToken`). */
export interface TseCredentials {
  serialNumber: string;
  accessToken: string;
}

/** Basic-Auth fuer einen Credit Token (`creditClientId` + `creditClientSecret`). */
export interface CreditTokenCredentials {
  clientId: string;
  secret: string;
}

export interface CreateCreditTokenRequest {
  metadata?: string | null;
  validProductTypes?: string[] | null;
  /** -1 = unbegrenzt, 0 = pausiert. */
  remainingTses?: number | null;
}

export interface CreatedCreditToken {
  creditClientId: string;
  creditClientSecret: string;
}

export interface CreditTokenInfo {
  creditClientId?: string;
  state: string;
  validProductTypes: string[];
  remainingTses: number | null;
  metadata?: string;
}

export interface CreateTseRequest {
  productType: string;
  /** Freitext bis 512 Byte. */
  metadata: string;
}

export interface TseCreationStatus {
  status: string;
  tseSerialNumber: string | null;
  tseAccessToken: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface ProductTypeUsage {
  mode: string;
  billingPeriodMonths: number | null;
  signaturesCurrentMonth: number | null;
  signatureDuration: number | null;
  signatureLimit: number | null;
  signaturesRemainingUntilNextLimit: number | null;
  topUpAmount: number | null;
  topUpsCurrentMonth: number | null;
  slowdownActive: boolean | null;
}

export interface TseInfo {
  serialNumber: string;
  productType: string | null;
  creditClientId: string | null;
  createdAt: number | null;
  deactivatedAt: number | null;
  certificationId: string | null;
  publicKey: string | null;
  healthState: string | null;
  initializationState: string | null;
  storageCapacity: number | null;
  storageUsed: number | null;
  numStartedTransactions: number | null;
  maxStartedTransactions: number | null;
  createdSignatures: number | null;
  numRegisteredClients: number | null;
  maxRegisteredClients: number | null;
  certificateExpirationDate: number | null;
  maxUpdateDelay: number | null;
  softwareVersion: string | null;
  logTimeFormat: string | null;
  signatureAlgorithm: string | null;
  transactionSignaturesPerMonth: Record<string, number>;
  productTypeUsage: ProductTypeUsage | null;
  metadata: string | null;
}

export interface TransactionRequest {
  clientId: string;
  processType: string;
  /** Klartext; der Client kodiert Base64. */
  processData: string;
}

export interface TransactionResponse {
  transactionNumber: number;
  /** Unix-Zeit in Sekunden (Log-Zeit der TSE). */
  signatureCreationTime: number;
  signatureCounter: number;
  /** Base64, 64 Byte dekodiert. */
  signatureValue: string;
}

export interface ExportStatus {
  id: string;
  /** Unix-Zeit in Sekunden. */
  createdAt: number | null;
  status: string;
  downloadUrl: string | null;
  filename: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface UsageReport {
  createdTses: Array<{ tseSerialNumber: string; productType: string }>;
  activeTses: Array<{
    tseSerialNumber: string;
    productType: string;
    autoTopUps: number | null;
  }>;
  deactivatedTses: Array<{ tseSerialNumber: string; productType: string }>;
}

export class SwissbitParseError extends Error {}

type Json = Record<string, unknown>;

function asRecord(value: unknown, what: string): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SwissbitParseError(`${what}: expected an object`);
  }
  return value as Json;
}

function str(record: Json, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function num(record: Json, key: string): number | null {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // Manche Generatoren liefern grosse Zahlen als Text.
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return null;
}

function bool(record: Json, key: string): boolean | null {
  const value = record[key];
  return typeof value === 'boolean' ? value : null;
}

function requiredStr(record: Json, key: string, what: string): string {
  const value = str(record, key);
  if (value === null) throw new SwissbitParseError(`${what}: missing ${key}`);
  return value;
}

function requiredNum(record: Json, key: string, what: string): number {
  const value = num(record, key);
  if (value === null) throw new SwissbitParseError(`${what}: missing ${key}`);
  return value;
}

/** Enum-Werte kommen teils als `AsyncJobStatus.success` (Doku-Beispiele). */
export function enumValue(value: string | null): string | null {
  if (value === null) return null;
  const dot = value.lastIndexOf('.');
  return dot >= 0 ? value.slice(dot + 1) : value;
}

export function parseCreatedCreditToken(body: unknown): CreatedCreditToken {
  const record = asRecord(body, 'createCreditToken');
  return {
    creditClientId: requiredStr(record, 'creditClientId', 'createCreditToken'),
    creditClientSecret: requiredStr(
      record,
      'creditClientSecret',
      'createCreditToken',
    ),
  };
}

export function parseCreditTokenInfo(body: unknown): CreditTokenInfo {
  const record = asRecord(body, 'creditToken');
  const types = record.validProductTypes;
  return {
    creditClientId: str(record, 'creditClientId') ?? undefined,
    state: enumValue(str(record, 'state')) ?? 'active',
    validProductTypes: Array.isArray(types)
      ? types.filter((t): t is string => typeof t === 'string')
      : [],
    remainingTses: num(record, 'remainingTses'),
    metadata: str(record, 'metadata') ?? undefined,
  };
}

export function parseCreateTse(body: unknown): { creationId: string } {
  const record = asRecord(body, 'createTse');
  return { creationId: requiredStr(record, 'creationId', 'createTse') };
}

export function parseCreationStatus(body: unknown): TseCreationStatus {
  const record = asRecord(body, 'creationStatus');
  return {
    status: enumValue(requiredStr(record, 'status', 'creationStatus'))!,
    tseSerialNumber: str(record, 'tseSerialNumber'),
    tseAccessToken: str(record, 'tseAccessToken'),
    errorCode: str(record, 'errorCode') || null,
    errorMessage: str(record, 'errorMessage') || null,
  };
}

function parseUsage(value: unknown): ProductTypeUsage | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Json;
  return {
    mode: enumValue(str(record, 'mode')) ?? 'unknown',
    billingPeriodMonths: num(record, 'billingPeriodMonths'),
    signaturesCurrentMonth: num(record, 'signaturesCurrentMonth'),
    signatureDuration: num(record, 'signatureDuration'),
    signatureLimit: num(record, 'signatureLimit'),
    signaturesRemainingUntilNextLimit: num(
      record,
      'signaturesRemainingUntilNextLimit',
    ),
    topUpAmount: num(record, 'topUpAmount'),
    topUpsCurrentMonth: num(record, 'topUpsCurrentMonth'),
    slowdownActive: bool(record, 'slowdownActive'),
  };
}

export function parseTseInfo(body: unknown): TseInfo {
  const record = asRecord(body, 'tseInfo');
  const perMonthRaw = record.transactionSignaturesPerMonth;
  const perMonth: Record<string, number> = {};
  if (perMonthRaw && typeof perMonthRaw === 'object') {
    for (const [month, count] of Object.entries(perMonthRaw as Json)) {
      if (typeof count === 'number') perMonth[month] = count;
    }
  }
  return {
    serialNumber: requiredStr(record, 'serialNumber', 'tseInfo'),
    productType: str(record, 'productType'),
    creditClientId: str(record, 'creditClientId'),
    createdAt: num(record, 'createdAt'),
    deactivatedAt: num(record, 'deactivatedAt'),
    certificationId: str(record, 'certificationId'),
    publicKey: str(record, 'publicKey'),
    healthState: enumValue(str(record, 'healthState')),
    initializationState: enumValue(str(record, 'initializationState')),
    storageCapacity: num(record, 'storageCapacity'),
    storageUsed: num(record, 'storageUsed'),
    numStartedTransactions: num(record, 'numStartedTransactions'),
    maxStartedTransactions: num(record, 'maxStartedTransactions'),
    createdSignatures: num(record, 'createdSignatures'),
    numRegisteredClients: num(record, 'numRegisteredClients'),
    maxRegisteredClients: num(record, 'maxRegisteredClients'),
    certificateExpirationDate: num(record, 'certificateExpirationDate'),
    maxUpdateDelay: num(record, 'maxUpdateDelay'),
    softwareVersion: str(record, 'softwareVersion'),
    logTimeFormat: str(record, 'logTimeFormat'),
    signatureAlgorithm: str(record, 'signatureAlgorithm'),
    transactionSignaturesPerMonth: perMonth,
    productTypeUsage: parseUsage(record.productTypeUsage),
    metadata: str(record, 'metadata'),
  };
}

export function parseTransactionResponse(body: unknown): TransactionResponse {
  const record = asRecord(body, 'transaction');
  return {
    transactionNumber: requiredNum(record, 'transactionNumber', 'transaction'),
    signatureCreationTime: requiredNum(
      record,
      'signatureCreationTime',
      'transaction',
    ),
    signatureCounter: requiredNum(record, 'signatureCounter', 'transaction'),
    signatureValue: requiredStr(record, 'signatureValue', 'transaction'),
  };
}

export function parseExportStatus(body: unknown): ExportStatus {
  const record = asRecord(body, 'export');
  return {
    id: requiredStr(record, 'id', 'export'),
    createdAt: num(record, 'createdAt'),
    status: enumValue(requiredStr(record, 'status', 'export'))!,
    downloadUrl: str(record, 'downloadUrl') || null,
    filename: str(record, 'filename') || null,
    errorCode: str(record, 'errorCode') || null,
    errorMessage: str(record, 'errorMessage') || null,
  };
}

export function parseExportList(body: unknown): ExportStatus[] {
  if (!Array.isArray(body)) {
    throw new SwissbitParseError('listExports: expected an array');
  }
  return body.map(parseExportStatus);
}

export function parseStringList(body: unknown, what: string): string[] {
  if (!Array.isArray(body)) {
    throw new SwissbitParseError(`${what}: expected an array`);
  }
  return body.filter((v): v is string => typeof v === 'string');
}

export function parseNumberList(body: unknown, what: string): number[] {
  if (!Array.isArray(body)) {
    throw new SwissbitParseError(`${what}: expected an array`);
  }
  return (body as unknown[])
    .map((v) => (typeof v === 'string' ? Number(v) : v))
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
}

export function parseCreditTokenList(body: unknown): CreditTokenInfo[] {
  if (!Array.isArray(body)) {
    throw new SwissbitParseError('listCreditTokens: expected an array');
  }
  return body.map(parseCreditTokenInfo);
}

export function parseUsageReport(body: unknown): UsageReport {
  const record = asRecord(body, 'usage');
  const items = (key: string) =>
    Array.isArray(record[key]) ? (record[key] as unknown[]) : [];
  const vendorItem = (v: unknown) => {
    const r = (v ?? {}) as Json;
    return {
      tseSerialNumber: str(r, 'tseSerialNumber') ?? '',
      productType: str(r, 'productType') ?? '',
    };
  };
  return {
    createdTses: items('createdTses').map(vendorItem),
    activeTses: items('activeTses').map((v) => ({
      ...vendorItem(v),
      autoTopUps: num((v ?? {}) as Json, 'autoTopUps'),
    })),
    deactivatedTses: items('deactivatedTses').map(vendorItem),
  };
}
