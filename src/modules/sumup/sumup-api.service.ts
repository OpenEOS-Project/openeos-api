import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import SumUp from '@sumup/sdk';
import {
  ErrorCodes,
  ErrorMessages,
  ErrorReasons,
} from '../../common/constants/error-codes';

// SumUp SDK's APIError has { status, error, response } but is not exported separately
interface SumUpAPIError extends Error {
  status: number;
  error: unknown;
  response: Response;
}

/** Upstream statuses that mean the stored API key / merchant code is wrong. */
const CREDENTIAL_STATUSES = new Set([401, 403]);

/**
 * The error a SumUp failure is reported with. Invalid credentials get their
 * own code so the UI can say what to fix; everything else stays
 * SUMUP_API_ERROR with the SumUp error type as message (the POS matches on
 * it, e.g. READER_BUSY). The upstream status is passed along in `details`.
 * The response status stays 400 either way — a 401 would log the user out.
 */
export function sumUpErrorResponse(
  status: number | undefined,
  type: string | undefined,
  detail: string | undefined,
  fallbackMessage: string,
): BadRequestException {
  const details =
    status !== undefined
      ? [
          {
            code: `SUMUP_HTTP_${status}`,
            message: detail || type || fallbackMessage,
          },
        ]
      : undefined;

  if (status !== undefined && CREDENTIAL_STATUSES.has(status)) {
    return new BadRequestException({
      code: ErrorCodes.SUMUP_INVALID_CREDENTIALS,
      message: ErrorMessages[ErrorCodes.SUMUP_INVALID_CREDENTIALS],
      errorType: type,
      details,
    });
  }

  return new BadRequestException({
    code: ErrorCodes.SUMUP_API_ERROR,
    message: type || detail || fallbackMessage,
    errorType: type,
    details,
  });
}

function isSumUpAPIError(err: unknown): err is SumUpAPIError {
  return (
    err instanceof Error &&
    'status' in err &&
    'error' in err &&
    typeof (err as { status?: unknown }).status === 'number'
  );
}

/**
 * Die Methoden des SDK-Clients, die wir benutzen.
 *
 * @sumup/sdk 0.0.x liefert Typdeklarationen, die unter
 * `moduleResolution: nodenext` nicht aufloesen: core.d.ts importiert ohne
 * Dateiendung, und `Core.APIPromise` wird zum Fehlertyp. Jedes `await` auf
 * einen SDK-Aufruf war deshalb stillschweigend `any`. Die Datentypen der
 * Ressourcen (Reader, StatusResponse, ...) sind dagegen intakt — hier werden
 * nur die Rueckgaben als gewoehnliche Promises beschrieben.
 */
interface SumUpClient {
  readers: {
    list(merchantCode: string): Promise<SumUp.Readers.ListReadersResponse>;
    create(
      merchantCode: string,
      body: SumUp.Readers.CreateReaderParams,
    ): Promise<SumUp.Readers.Reader>;
    getStatus(
      merchantCode: string,
      readerId: string,
    ): Promise<SumUp.Readers.StatusResponse>;
    update(
      merchantCode: string,
      readerId: string,
      body: SumUp.Readers.UpdateReaderParams,
    ): Promise<SumUp.Readers.Reader>;
    delete(merchantCode: string, readerId: string): Promise<void>;
    createCheckout(
      merchantCode: string,
      readerId: string,
      body: SumUp.Readers.CreateReaderCheckoutRequest,
    ): Promise<SumUp.Readers.CreateReaderCheckoutResponse>;
    terminateCheckout(
      merchantCode: string,
      readerId: string,
      body?: SumUp.Readers.CreateReaderTerminateParams,
    ): Promise<void>;
  };
  transactions: {
    get(
      merchantCode: string,
      query: { client_transaction_id?: string; id?: string },
    ): Promise<SumUp.Transactions.TransactionFull>;
    /** `POST /v0.1/me/refund/{txn_id}`, Betrag in Euro (ohne = voll). */
    refund(
      txnId: string,
      body?: SumUp.Transactions.RefundTransactionParams,
    ): Promise<void>;
  };
}

@Injectable()
export class SumUpApiService {
  private readonly logger = new Logger(SumUpApiService.name);

  private createClient(apiKey: string): SumUpClient {
    // Die einzige Stelle, an der die kaputten SDK-Typen (s. o.) auf unsere
    // Beschreibung treffen.
    return new SumUp({ apiKey }) as unknown as SumUpClient;
  }

  /**
   * Extract error type and detail from a SumUp API error response.
   * The SDK's APIError.error contains the parsed JSON body, e.g.:
   * { errors: { type: "READER_BUSY" } } or { errors: { detail: "some message" } }
   */
  private extractSumUpError(error: unknown): {
    type?: string;
    detail?: string;
    status?: number;
  } {
    if (!isSumUpAPIError(error)) return {};

    const body = error.error;
    const result: { type?: string; detail?: string; status: number } = {
      status: error.status,
    };

    if (typeof body === 'object' && body !== null) {
      // Je nach Endpunkt: { errors: { type, detail } }, ein Array
      // [{ error_code, message }] oder { error_code, message } direkt.
      const raw = body as {
        errors?: unknown;
        error_code?: string;
        message?: string;
        detail?: string;
      };
      const first = Array.isArray(body)
        ? (body[0] as { error_code?: string; message?: string } | undefined)
        : Array.isArray(raw.errors)
          ? (raw.errors[0] as { code?: string; detail?: string } | undefined)
          : undefined;
      const errors = (
        raw.errors && !Array.isArray(raw.errors) ? raw.errors : undefined
      ) as { type?: string; detail?: string } | undefined;
      if (errors?.type) result.type = errors.type;
      if (errors?.detail) result.detail = errors.detail;
      if (!result.type && first) {
        const entry = first as {
          error_code?: string;
          code?: string;
          message?: string;
          detail?: string;
        };
        result.type = entry.error_code ?? entry.code;
        result.detail = entry.message ?? entry.detail;
      }
      if (!result.type && raw.error_code) result.type = raw.error_code;
      if (!result.detail && (raw.message || raw.detail)) {
        result.detail = raw.message ?? raw.detail;
      }
    }

    return result;
  }

  private async execute<T>(fn: () => Promise<T>, context: string): Promise<T> {
    try {
      return await fn();
    } catch (error: unknown) {
      if (
        error instanceof BadRequestException ||
        error instanceof InternalServerErrorException
      ) {
        throw error;
      }

      const sumupErr = this.extractSumUpError(error);
      const message = error instanceof Error ? error.message : 'Unknown error';

      this.logger.warn(
        `SumUp API error [${context}]: status=${sumupErr.status} type=${sumupErr.type} detail=${sumupErr.detail} message=${message}`,
      );

      throw sumUpErrorResponse(
        sumupErr.status,
        sumupErr.type,
        sumupErr.detail,
        `SumUp: ${message}`,
      );
    }
  }

  async listReaders(
    apiKey: string,
    merchantCode: string,
  ): Promise<SumUp.Readers.Reader[]> {
    const client = this.createClient(apiKey);
    return this.execute(async () => {
      const result = await client.readers.list(merchantCode);
      return result?.items || [];
    }, 'listReaders');
  }

  async pairReader(
    apiKey: string,
    merchantCode: string,
    pairingCode: string,
    name: string,
  ): Promise<SumUp.Readers.Reader> {
    const client = this.createClient(apiKey);
    return this.execute(
      () =>
        client.readers.create(merchantCode, {
          pairing_code: pairingCode,
          name,
        }),
      'pairReader',
    );
  }

  async getReaderStatus(
    apiKey: string,
    merchantCode: string,
    readerId: string,
  ): Promise<SumUp.Readers.StatusResponse> {
    const client = this.createClient(apiKey);
    return this.execute(
      () => client.readers.getStatus(merchantCode, readerId),
      'getReaderStatus',
    );
  }

  /**
   * Resolve the result of a reader checkout via the Transactions API. The
   * reader status endpoint only reports device telemetry (battery/connection),
   * never the payment outcome — that lives on the transaction created from the
   * checkout's client_transaction_id. Returns null while the transaction does
   * not exist yet (customer hasn't paid), which the caller treats as pending.
   */
  async getTransactionStatus(
    apiKey: string,
    merchantCode: string,
    clientTransactionId: string,
  ): Promise<{ status: string | null }> {
    const client = this.createClient(apiKey);
    try {
      const txn = await client.transactions.get(merchantCode, {
        client_transaction_id: clientTransactionId,
      });
      return { status: txn?.status ?? null };
    } catch {
      return { status: null };
    }
  }

  /**
   * Erstattet (ganz oder teilweise) eine Kartenzahlung ueber die SumUp-API.
   *
   * Die Kasse speichert an der Zahlung die `client_transaction_id` des
   * Lesegeraet-Checkouts; der Erstattungs-Endpunkt braucht dagegen die
   * Transaktions-ID. Sie wird deshalb zuerst ueber
   * `GET /v2.1/merchants/{merchant_code}/transactions?client_transaction_id=`
   * aufgeloest (faellt zurueck auf `?id=`, falls schon eine Transaktions-ID
   * gespeichert ist), dann folgt `POST /v0.1/me/refund/{txn_id}` mit
   * `{ amount }` in Euro. Antwort 204 ohne Inhalt.
   *
   * Fehler kommen als SUMUP_API_ERROR / SUMUP_INVALID_CREDENTIALS mit dem
   * SumUp-Status in `details` (z. B. 404 unbekannte Transaktion, 409 nicht
   * erstattbar, 422 Betrag ueber dem erstattbaren Rest / zu wenig Guthaben).
   */
  async refundTransaction(
    apiKey: string,
    merchantCode: string,
    reference: string,
    amount: number,
  ): Promise<{ transactionId: string; transactionCode: string | null }> {
    const client = this.createClient(apiKey);
    const txn = await this.execute(async () => {
      try {
        return await client.transactions.get(merchantCode, {
          client_transaction_id: reference,
        });
      } catch (error) {
        if (isSumUpAPIError(error) && error.status === 404) {
          return client.transactions.get(merchantCode, { id: reference });
        }
        throw error;
      }
    }, 'refundTransaction (lookup)');
    const transactionId = txn?.id;
    if (!transactionId) {
      throw sumUpErrorResponse(
        404,
        'TRANSACTION_NOT_FOUND',
        'Transaktion bei SumUp nicht gefunden',
        'SumUp: Transaktion nicht gefunden',
      );
    }
    await this.execute(
      () =>
        client.transactions.refund(transactionId, {
          amount: Math.round(amount * 100) / 100,
        }),
      'refundTransaction',
    );
    this.logger.log(
      `SumUp refund of ${amount.toFixed(2)} for transaction ${transactionId}`,
    );
    return {
      transactionId,
      transactionCode: txn.transaction_code ?? null,
    };
  }

  async updateReader(
    apiKey: string,
    merchantCode: string,
    readerId: string,
    name: string,
  ): Promise<SumUp.Readers.Reader> {
    const client = this.createClient(apiKey);
    return this.execute(
      () => client.readers.update(merchantCode, readerId, { name }),
      'updateReader',
    );
  }

  async deleteReader(
    apiKey: string,
    merchantCode: string,
    readerId: string,
  ): Promise<void> {
    const client = this.createClient(apiKey);
    return this.execute(
      () => client.readers.delete(merchantCode, readerId),
      'deleteReader',
    );
  }

  async initiateCheckout(
    apiKey: string,
    merchantCode: string,
    readerId: string,
    data: {
      amount: number;
      currency: string;
      affiliateKey?: string;
      appId?: string;
    },
  ): Promise<SumUp.Readers.CreateReaderCheckoutResponse> {
    const client = this.createClient(apiKey);

    const checkoutRequest: SumUp.Readers.CreateReaderCheckoutRequest = {
      total_amount: {
        value: Math.round(data.amount * 100),
        currency: data.currency,
        minor_unit: 2,
      },
    };

    if (data.affiliateKey && data.appId) {
      checkoutRequest.affiliate = {
        key: data.affiliateKey,
        app_id: data.appId,
        foreign_transaction_id: crypto.randomUUID(),
      };
    }

    try {
      return await this.execute(
        () =>
          client.readers.createCheckout(
            merchantCode,
            readerId,
            checkoutRequest,
          ),
        'initiateCheckout',
      );
    } catch (error: unknown) {
      // If reader is busy from a previous checkout, terminate and retry once
      const errMsg =
        error instanceof BadRequestException
          ? (error.getResponse() as { errorType?: string })?.errorType
          : undefined;

      if (errMsg === 'READER_BUSY') {
        this.logger.log(
          'Reader busy — terminating previous checkout and retrying...',
        );
        try {
          await client.readers.terminateCheckout(merchantCode, readerId, {});
          // Wait for the reader to process the termination
          await new Promise((resolve) => setTimeout(resolve, 2000));
        } catch (termErr) {
          this.logger.warn(`Failed to terminate previous checkout: ${termErr}`);
        }

        return this.execute(
          () =>
            client.readers.createCheckout(
              merchantCode,
              readerId,
              checkoutRequest,
            ),
          'initiateCheckout (retry after terminate)',
        );
      }

      throw error;
    }
  }

  async terminateCheckout(
    apiKey: string,
    merchantCode: string,
    readerId: string,
  ): Promise<void> {
    const client = this.createClient(apiKey);
    this.logger.log(`Terminating checkout on reader ${readerId}...`);
    await this.execute(
      () => client.readers.terminateCheckout(merchantCode, readerId, {}),
      'terminateCheckout',
    );
    this.logger.log(
      `Terminate checkout request sent successfully for reader ${readerId}`,
    );
  }

  async createOnlineCheckout(
    apiKey: string,
    merchantCode: string,
    data: {
      amount: number;
      currency: string;
      description: string;
      checkoutReference: string;
      /** Server-side webhook that SumUp POSTs payment-status updates to. */
      returnUrl: string;
      /** Where the shopper's BROWSER is redirected after paying. */
      redirectUrl: string;
    },
  ): Promise<{ id: string; checkoutUrl: string }> {
    const response = await fetch('https://api.sumup.com/v0.1/checkouts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        amount: data.amount,
        currency: data.currency,
        description: data.description,
        checkout_reference: data.checkoutReference,
        // SumUp semantics: return_url = async status webhook (server POST),
        // redirect_url = customer redirect after the hosted checkout.
        return_url: data.returnUrl,
        redirect_url: data.redirectUrl,
        merchant_code: merchantCode,
        hosted_checkout: { enabled: true },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`SumUp online checkout failed: ${error}`);
      throw sumUpErrorResponse(
        response.status,
        undefined,
        undefined,
        `SumUp online checkout failed: ${response.status}`,
      );
    }

    const result = (await response.json()) as {
      id: string;
      hosted_checkout_url?: string;
      checkout_url?: string;
    };
    const checkoutUrl = result.hosted_checkout_url ?? result.checkout_url;
    if (!checkoutUrl) {
      this.logger.error(
        `SumUp checkout ${result.id} created without hosted URL (response missing hosted_checkout_url)`,
      );
      throw new BadRequestException({
        code: ErrorCodes.SUMUP_API_ERROR,
        reason: ErrorReasons.SUMUP_NO_CHECKOUT_URL,
        message: 'SumUp hat keine Bezahlseite zurückgegeben',
      });
    }
    return { id: result.id, checkoutUrl };
  }
}
