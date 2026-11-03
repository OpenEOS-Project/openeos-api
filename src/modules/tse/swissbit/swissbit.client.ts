import {
  SwissbitHttp,
  type BasicAuth,
  type DownloadResult,
} from './swissbit-http';
import { SwissbitError } from './swissbit.errors';
import {
  SwissbitParseError,
  parseCreateTse,
  parseCreatedCreditToken,
  parseCreationStatus,
  parseCreditTokenInfo,
  parseCreditTokenList,
  parseExportList,
  parseExportStatus,
  parseNumberList,
  parseStringList,
  parseTransactionResponse,
  parseTseInfo,
  parseUsageReport,
  type CreateCreditTokenRequest,
  type CreateTseRequest,
  type CreatedCreditToken,
  type CreditTokenCredentials,
  type CreditTokenInfo,
  type ExportStatus,
  type TransactionRequest,
  type TransactionResponse,
  type TseCreationStatus,
  type TseCredentials,
  type TseInfo,
  type UsageReport,
} from './swissbit.types';

export interface SwissbitTimeouts {
  /** start/update/finishTransaction. */
  transactionMs: number;
  /** Verwaltung (TSE anlegen, Status, Clients, Exporte). */
  adminMs: number;
  /** Download eines Exports. */
  downloadMs: number;
}

export const DEFAULT_SWISSBIT_TIMEOUTS: SwissbitTimeouts = {
  transactionMs: 5_000,
  adminMs: 15_000,
  downloadMs: 10 * 60_000,
};

export interface SwissbitClientOptions {
  baseUrl: string;
  vendor?: { client: string; secret: string } | null;
  timeouts?: Partial<SwissbitTimeouts>;
  maxSockets?: number;
  onError?: (error: SwissbitError) => void;
  /** Fuer Tests: fertige HTTP-Schicht. */
  http?: SwissbitHttp;
}

/** Ergebnis mit REQUEST-ID und Dauer (fuer `tse_transactions`). */
export interface Timed<T> {
  value: T;
  requestId: string;
  durationMs: number;
}

/**
 * Getippter Client fuer die Swissbit Cloud-TSE 2 (Billing- und POS-API
 * v1.1.1, `api-billing.json` / `api-pos.json`).
 *
 * Eine Instanz je Basis-URL: sie haelt die Keep-Alive-Verbindungen. Die
 * Zugangsdaten (Vendor, Credit Token, TSE) gehen je Aufruf mit — eine TSE
 * wird ueber ihre Basic-Auth adressiert, nicht ueber den Pfad.
 */
export class SwissbitClient {
  readonly http: SwissbitHttp;
  readonly timeouts: SwissbitTimeouts;
  private readonly vendor: { client: string; secret: string } | null;

  constructor(options: SwissbitClientOptions) {
    this.http =
      options.http ??
      new SwissbitHttp({
        baseUrl: options.baseUrl,
        maxSockets: options.maxSockets,
        onError: options.onError,
      });
    this.timeouts = { ...DEFAULT_SWISSBIT_TIMEOUTS, ...options.timeouts };
    this.vendor = options.vendor ?? null;
  }

  destroy(): void {
    this.http.destroy();
  }

  // ---------------------------------------------------------------- Auth

  private vendorAuth(): BasicAuth {
    if (!this.vendor?.client || !this.vendor.secret) {
      throw new Error(
        'Swissbit vendor credentials are not configured (SWISSBIT_VENDOR_CLIENT/SECRET)',
      );
    }
    return { user: this.vendor.client, password: this.vendor.secret };
  }

  private static creditAuth(credit: CreditTokenCredentials): BasicAuth {
    return { user: credit.clientId, password: credit.secret };
  }

  private static tseAuth(tse: TseCredentials): BasicAuth {
    return { user: tse.serialNumber, password: tse.accessToken };
  }

  private async call<T>(
    operation: string,
    parse: (body: unknown) => T,
    req: Omit<Parameters<SwissbitHttp['request']>[0], 'operation'>,
  ): Promise<Timed<T>> {
    const res = await this.http.request({ ...req, operation });
    try {
      return {
        value: parse(res.body),
        requestId: res.requestId,
        durationMs: res.durationMs,
      };
    } catch (error) {
      if (error instanceof SwissbitParseError) {
        throw new SwissbitError({
          operation,
          status: res.status,
          errorCode: 'E_UNEXPECTED_RESPONSE',
          message: error.message,
          requestId: res.requestId,
          durationMs: res.durationMs,
        });
      }
      throw error;
    }
  }

  // ----------------------------------------------------- Billing (Vendor)

  createCreditToken(
    body: CreateCreditTokenRequest = {},
  ): Promise<Timed<CreatedCreditToken>> {
    return this.call('createCreditToken', parseCreatedCreditToken, {
      method: 'POST',
      path: '/api/v1/creditTokens',
      auth: this.vendorAuth(),
      body,
      timeoutMs: this.timeouts.adminMs,
    });
  }

  listCreditTokens(): Promise<Timed<CreditTokenInfo[]>> {
    return this.call('listCreditTokens', parseCreditTokenList, {
      method: 'GET',
      path: '/api/v1/creditTokens',
      auth: this.vendorAuth(),
      timeoutMs: this.timeouts.adminMs,
    });
  }

  listTsesForCreditToken(
    creditClientId: string,
  ): Promise<Timed<Array<{ tseSerialNumber: string; productType: string }>>> {
    return this.call(
      'listTsesForCreditToken',
      (body) => parseUsageReport({ createdTses: body }).createdTses,
      {
        method: 'GET',
        path: `/api/v1/creditTokens/${encodeURIComponent(creditClientId)}/tses`,
        auth: this.vendorAuth(),
        timeoutMs: this.timeouts.adminMs,
      },
    );
  }

  usageReport(
    creditClientId: string,
    year: number,
    month: number,
  ): Promise<Timed<UsageReport>> {
    return this.call('usageReport', parseUsageReport, {
      method: 'GET',
      path: `/api/v1/creditTokens/${encodeURIComponent(creditClientId)}/usage`,
      query: { year, month },
      auth: this.vendorAuth(),
      timeoutMs: this.timeouts.adminMs,
    });
  }

  vendorTseInfo(serialNumber: string): Promise<Timed<TseInfo>> {
    return this.call('vendorTseInfo', parseTseInfo, {
      method: 'GET',
      path: `/api/v1/manage/tse/${encodeURIComponent(serialNumber)}`,
      auth: this.vendorAuth(),
      timeoutMs: this.timeouts.adminMs,
    });
  }

  vendorDisableSecureElement(serialNumber: string): Promise<Timed<null>> {
    return this.call('vendorDisableSecureElement', () => null, {
      method: 'POST',
      path: `/api/v1/manage/tse/${encodeURIComponent(serialNumber)}/disableSecureElement`,
      auth: this.vendorAuth(),
      timeoutMs: this.timeouts.adminMs,
    });
  }

  // ------------------------------------------------ POS: Credit Token

  creditTokenInfo(
    credit: CreditTokenCredentials,
  ): Promise<Timed<CreditTokenInfo>> {
    return this.call('creditTokenInfo', parseCreditTokenInfo, {
      method: 'GET',
      path: '/api/v1/creditToken',
      auth: SwissbitClient.creditAuth(credit),
      timeoutMs: this.timeouts.adminMs,
    });
  }

  createTse(
    credit: CreditTokenCredentials,
    body: CreateTseRequest,
  ): Promise<Timed<{ creationId: string }>> {
    return this.call('createTse', parseCreateTse, {
      method: 'POST',
      path: '/api/v1/tses',
      auth: SwissbitClient.creditAuth(credit),
      body,
      timeoutMs: this.timeouts.adminMs,
    });
  }

  /**
   * Stand der Anlage. Achtung: die Erfolgsantwort (mit Access Token) gibt
   * es **genau einmal**, danach 404 `E_JOB_NOT_FOUND`.
   */
  creationStatus(
    credit: CreditTokenCredentials,
    creationId: string,
  ): Promise<Timed<TseCreationStatus>> {
    return this.call('creationStatus', parseCreationStatus, {
      method: 'GET',
      path: `/api/v1/tses/${encodeURIComponent(creationId)}`,
      auth: SwissbitClient.creditAuth(credit),
      timeoutMs: this.timeouts.adminMs,
    });
  }

  // ------------------------------------------------------------ POS: TSE

  info(tse: TseCredentials): Promise<Timed<TseInfo>> {
    return this.call('info', parseTseInfo, {
      method: 'GET',
      path: '/api/v1/tse',
      auth: SwissbitClient.tseAuth(tse),
      timeoutMs: this.timeouts.adminMs,
    });
  }

  changeTse(tse: TseCredentials, metadata: string): Promise<Timed<null>> {
    return this.call('changeTse', () => null, {
      method: 'PUT',
      path: '/api/v1/tse',
      auth: SwissbitClient.tseAuth(tse),
      body: { metadata },
      timeoutMs: this.timeouts.adminMs,
    });
  }

  /** Endgueltig. Exportiert den Rest automatisch (siehe listExports). */
  disableSecureElement(tse: TseCredentials): Promise<Timed<null>> {
    return this.call('disableSecureElement', () => null, {
      method: 'POST',
      path: '/api/v1/tse/disableSecureElement',
      auth: SwissbitClient.tseAuth(tse),
      timeoutMs: this.timeouts.adminMs,
    });
  }

  // -------------------------------------------------------- POS: Clients

  registerClient(tse: TseCredentials, clientId: string): Promise<Timed<null>> {
    return this.call('registerClient', () => null, {
      method: 'POST',
      path: '/api/v1/tse/registerClient',
      auth: SwissbitClient.tseAuth(tse),
      body: { clientId },
      timeoutMs: this.timeouts.adminMs,
    });
  }

  deregisterClient(
    tse: TseCredentials,
    clientId: string,
  ): Promise<Timed<null>> {
    return this.call('deregisterClient', () => null, {
      method: 'POST',
      path: '/api/v1/tse/deregisterClient',
      auth: SwissbitClient.tseAuth(tse),
      body: { clientId },
      timeoutMs: this.timeouts.adminMs,
    });
  }

  listClients(tse: TseCredentials): Promise<Timed<string[]>> {
    return this.call(
      'listClients',
      (body) => parseStringList(body, 'listClients'),
      {
        method: 'GET',
        path: '/api/v1/tse/clients',
        auth: SwissbitClient.tseAuth(tse),
        timeoutMs: this.timeouts.adminMs,
      },
    );
  }

  // --------------------------------------------------- POS: Transaktionen

  private static txBody(req: TransactionRequest, transactionNumber?: number) {
    return {
      clientId: req.clientId,
      processType: req.processType,
      processData: Buffer.from(req.processData, 'utf8').toString('base64'),
      ...(transactionNumber !== undefined ? { transactionNumber } : {}),
    };
  }

  startTransaction(
    tse: TseCredentials,
    req: TransactionRequest,
    timeoutMs = this.timeouts.transactionMs,
  ): Promise<Timed<TransactionResponse>> {
    return this.call('startTransaction', parseTransactionResponse, {
      method: 'POST',
      path: '/api/v1/tse/startTransaction',
      auth: SwissbitClient.tseAuth(tse),
      body: SwissbitClient.txBody(req),
      timeoutMs,
    });
  }

  updateTransaction(
    tse: TseCredentials,
    transactionNumber: number,
    req: TransactionRequest,
    timeoutMs = this.timeouts.transactionMs,
  ): Promise<Timed<TransactionResponse>> {
    return this.call('updateTransaction', parseTransactionResponse, {
      method: 'POST',
      path: '/api/v1/tse/updateTransaction',
      auth: SwissbitClient.tseAuth(tse),
      body: SwissbitClient.txBody(req, transactionNumber),
      timeoutMs,
    });
  }

  finishTransaction(
    tse: TseCredentials,
    transactionNumber: number,
    req: TransactionRequest,
    timeoutMs = this.timeouts.transactionMs,
  ): Promise<Timed<TransactionResponse>> {
    return this.call('finishTransaction', parseTransactionResponse, {
      method: 'POST',
      path: '/api/v1/tse/finishTransaction',
      auth: SwissbitClient.tseAuth(tse),
      body: SwissbitClient.txBody(req, transactionNumber),
      timeoutMs,
    });
  }

  /** Teuer laut Swissbit — nur zur Fehlerbehebung (Abgleich). */
  getLastTransactionResponse(
    tse: TseCredentials,
    clientId: string,
  ): Promise<Timed<TransactionResponse>> {
    return this.call('getLastTransactionResponse', parseTransactionResponse, {
      method: 'GET',
      path: `/api/v1/tse/getLastTransactionResponse/${encodeURIComponent(clientId)}`,
      auth: SwissbitClient.tseAuth(tse),
      timeoutMs: this.timeouts.adminMs,
    });
  }

  /** Nummern aller begonnenen, nicht beendeten Transaktionen. */
  listStartedTransactions(tse: TseCredentials): Promise<Timed<number[]>> {
    return this.call(
      'listTransactions',
      (body) => parseNumberList(body, 'listTransactions'),
      {
        method: 'GET',
        path: '/api/v1/tse/transactions',
        auth: SwissbitClient.tseAuth(tse),
        timeoutMs: this.timeouts.adminMs,
      },
    );
  }

  // ----------------------------------------------------------- POS: Export

  listExports(tse: TseCredentials): Promise<Timed<ExportStatus[]>> {
    return this.call('listExports', parseExportList, {
      method: 'GET',
      path: '/api/v1/tse/export',
      auth: SwissbitClient.tseAuth(tse),
      timeoutMs: this.timeouts.adminMs,
    });
  }

  startExport(tse: TseCredentials): Promise<Timed<{ id: string }>> {
    return this.call(
      'startExport',
      (body) => ({
        id: parseExportStatus({ status: 'pending', ...(body as object) }).id,
      }),
      {
        method: 'POST',
        path: '/api/v1/tse/export',
        auth: SwissbitClient.tseAuth(tse),
        timeoutMs: this.timeouts.adminMs,
      },
    );
  }

  exportStatus(
    tse: TseCredentials,
    exportId: string,
  ): Promise<Timed<ExportStatus>> {
    return this.call('exportStatus', parseExportStatus, {
      method: 'GET',
      path: `/api/v1/tse/export/${encodeURIComponent(exportId)}`,
      auth: SwissbitClient.tseAuth(tse),
      timeoutMs: this.timeouts.adminMs,
    });
  }

  /**
   * Loescht einen Export **endgueltig** bei Swissbit. Nur nach
   * erfolgreichem Download und Ablage im Archiv aufrufen — Swissbit nimmt
   * neue Exporte erst an, wenn alle erfolgreichen geloescht sind.
   */
  deleteExport(tse: TseCredentials, exportId: string): Promise<Timed<null>> {
    return this.call('deleteExport', () => null, {
      method: 'DELETE',
      path: `/api/v1/tse/export/${encodeURIComponent(exportId)}`,
      auth: SwissbitClient.tseAuth(tse),
      timeoutMs: this.timeouts.adminMs,
    });
  }

  downloadExport(
    downloadUrl: string,
    targetPath: string,
  ): Promise<DownloadResult> {
    return this.http.download(
      downloadUrl,
      targetPath,
      this.timeouts.downloadMs,
    );
  }
}
