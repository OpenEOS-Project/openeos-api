/**
 * Fehler der Swissbit Cloud-TSE 2 (Billing- und POS-API, v1.1.1).
 *
 * Jede Antwort ausser 2xx wird zu genau einer dieser Klassen. Die
 * Fehlercodes stammen aus den OpenAPI-Beschreibungen (`errorCode` im
 * Antwortkoerper); unbekannte Codes bleiben als Text erhalten, damit eine
 * neue Fehlerart nicht zum Absturz fuehrt.
 *
 * `requestId` ist der `REQUEST-ID`-Header des Aufrufs — Swissbit braucht
 * ihn im Support-Fall. Er steht in jedem Log-Eintrag zu einem Fehler.
 */

/** Fehlercodes aus api-pos.json und api-billing.json. */
export type SwissbitErrorCode =
  | 'E_AUTH_FAILED'
  | 'E_PARAM_LENGTH'
  | 'E_TSE_DISABLED'
  | 'E_CERT_EXPIRED'
  | 'E_STORAGE_FULL'
  | 'E_CLIENT_INVALID_CHAR'
  | 'E_CLIENT_ALREADY_REGISTERED'
  | 'E_CLIENT_LIMIT_REACHED'
  | 'E_CLIENT_NOT_REGISTERED'
  | 'E_MAX_OPEN_TX_REACHED'
  | 'E_TX_NOT_STARTED'
  | 'E_NO_LAST_TRANSACTION_RESPONSE'
  | 'E_EXPORT_ALREADY_IN_PROGRESS'
  | 'E_EXPORT_RESULT_PENDING'
  | 'E_JOB_NOT_FOUND'
  | 'E_JOB_STATE_INVALID'
  | 'E_TSE_TOO_MANY_REQUESTS'
  | 'E_INTERNAL_SERVER_ERROR'
  | 'E_SIGNATURE_CREATION_FAILED'
  | 'E_MAINTENANCE_IN_PROGRESS'
  | 'E_TSE_DEFECT'
  | 'E_TSE_STOPPED'
  | 'E_CREDIT_TOKEN_TERMINATED'
  | 'E_PRODUCT_TYPE_INVALID'
  | 'E_CREDIT_TOKEN_TSE_LIMIT_REACHED'
  | 'E_CREDIT_TOKEN_NOT_FOUND'
  | 'E_TSE_NOT_FOUND'
  // Eigene Codes fuer Fehler ohne Antwort von Swissbit.
  | 'E_TIMEOUT'
  | 'E_NETWORK'
  | 'E_VALIDATION'
  | 'E_UNEXPECTED_RESPONSE';

export interface SwissbitErrorInit {
  operation: string;
  status: number | null;
  errorCode: string;
  message: string;
  requestId: string;
  durationMs?: number;
}

export class SwissbitError extends Error {
  readonly operation: string;
  /** HTTP-Status; `null` bei Zeitueberschreitung oder Netzfehler. */
  readonly status: number | null;
  /** Ein `SwissbitErrorCode` oder ein neuer, uns unbekannter Code. */
  readonly errorCode: string;
  readonly requestId: string;
  readonly durationMs: number | undefined;

  constructor(init: SwissbitErrorInit) {
    super(
      `Swissbit ${init.operation} failed: ${init.errorCode} (${init.status ?? 'no response'}) ${init.message} [REQUEST-ID ${init.requestId}]`,
    );
    this.name = new.target.name;
    this.operation = init.operation;
    this.status = init.status;
    this.errorCode = init.errorCode;
    this.requestId = init.requestId;
    this.durationMs = init.durationMs;
  }

  /** Lohnt ein spaeterer Versuch (Ausfall, Wartung, Last)? */
  get retryable(): boolean {
    return false;
  }
}

/** 401 `E_AUTH_FAILED`: Zugangsdaten (Vendor, Credit Token, TSE) falsch. */
export class SwissbitAuthError extends SwissbitError {}

/** 404: Job, TSE oder Credit Token unbekannt. */
export class SwissbitNotFoundError extends SwissbitError {}

/** 400 mit fachlichem Fehlercode (z. B. `E_CLIENT_NOT_REGISTERED`). */
export class SwissbitRequestError extends SwissbitError {}

/** 422: Anfrage passt nicht zum Schema (Programmierfehler bei uns). */
export class SwissbitValidationError extends SwissbitError {}

/**
 * Swissbit voruebergehend nicht nutzbar: 429, 5xx (inkl. Wartung, TSE
 * gestoppt/defekt), keine Antwort, Netzfehler oder Zeitueberschreitung.
 */
export class SwissbitUnavailableError extends SwissbitError {
  override get retryable(): boolean {
    return this.errorCode !== 'E_TSE_DEFECT';
  }
}

/** Keine Antwort innerhalb der Frist. Ob Swissbit den Aufruf verarbeitet hat, ist offen. */
export class SwissbitTimeoutError extends SwissbitUnavailableError {}

export function isSwissbitError(error: unknown): error is SwissbitError {
  return error instanceof SwissbitError;
}

/** Fehlercode fuer Protokoll und Datenbank, auch fuer fremde Fehler. */
export function errorCodeOf(error: unknown): string {
  if (isSwissbitError(error)) return error.errorCode;
  return 'E_INTERNAL';
}

/** Kurzer Text fuer Protokoll und Datenbank (ohne Zugangsdaten). */
export function errorMessageOf(error: unknown, max = 500): string {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'unknown error';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Baut aus Status und Antwortkoerper die passende Fehlerklasse. */
export function swissbitErrorFromResponse(
  init: Omit<SwissbitErrorInit, 'errorCode' | 'message'> & { body: unknown },
): SwissbitError {
  const { body, ...rest } = init;
  let errorCode = 'E_UNEXPECTED_RESPONSE';
  let message = '';
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (typeof record.errorCode === 'string') errorCode = record.errorCode;
    if (typeof record.errorMessage === 'string') message = record.errorMessage;
  } else if (Array.isArray(body)) {
    // 422: Liste von Validierungsfehlern ({ loc, msg, type_ }).
    errorCode = 'E_VALIDATION';
    message = body
      .slice(0, 3)
      .map((entry) => {
        const record = (entry ?? {}) as Record<string, unknown>;
        const loc = Array.isArray(record.loc) ? record.loc.join('.') : '';
        const msg = typeof record.msg === 'string' ? record.msg : '';
        return `${loc} ${msg}`.trim();
      })
      .join('; ');
  }
  const status = rest.status;
  const full = { ...rest, errorCode, message };
  if (status === 401) return new SwissbitAuthError(full);
  if (status === 404) return new SwissbitNotFoundError(full);
  if (status === 422) return new SwissbitValidationError(full);
  if (status === 429 || (status !== null && status >= 500)) {
    return new SwissbitUnavailableError(full);
  }
  if (status === 400) return new SwissbitRequestError(full);
  return new SwissbitError(full);
}
