import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import SumUp from '@sumup/sdk';
import { ErrorCodes } from '../../common/constants/error-codes';

// SumUp SDK's APIError has { status, error, response } but is not exported separately
interface SumUpAPIError extends Error {
  status: number;
  error: unknown;
  response: Response;
}

function isSumUpAPIError(err: unknown): err is SumUpAPIError {
  return (
    err instanceof Error &&
    'status' in err &&
    'error' in err &&
    typeof (err as any).status === 'number'
  );
}

@Injectable()
export class SumUpApiService {
  private readonly logger = new Logger(SumUpApiService.name);

  private createClient(apiKey: string): SumUp {
    return new SumUp({ apiKey });
  }

  /**
   * Extract error type and detail from a SumUp API error response.
   * The SDK's APIError.error contains the parsed JSON body, e.g.:
   * { errors: { type: "READER_BUSY" } } or { errors: { detail: "some message" } }
   */
  private extractSumUpError(error: unknown): { type?: string; detail?: string; status?: number } {
    if (!isSumUpAPIError(error)) return {};

    const body = error.error;
    const result: { type?: string; detail?: string; status: number } = { status: error.status };

    if (typeof body === 'object' && body !== null) {
      const errors = (body as any).errors;
      if (errors?.type) result.type = errors.type;
      if (errors?.detail) result.detail = errors.detail;
    }

    return result;
  }

  private async execute<T>(fn: () => Promise<T>, context: string): Promise<T> {
    try {
      return await fn();
    } catch (error: unknown) {
      if (error instanceof BadRequestException || error instanceof InternalServerErrorException) {
        throw error;
      }

      const sumupErr = this.extractSumUpError(error);
      const message = error instanceof Error ? error.message : 'Unknown error';

      this.logger.warn(
        `SumUp API error [${context}]: status=${sumupErr.status} type=${sumupErr.type} detail=${sumupErr.detail} message=${message}`,
      );

      throw new BadRequestException({
        code: ErrorCodes.SUMUP_API_ERROR,
        message: sumupErr.type || sumupErr.detail || `SumUp: ${message}`,
        errorType: sumupErr.type,
      });
    }
  }

  async listReaders(apiKey: string, merchantCode: string): Promise<SumUp.Readers.Reader[]> {
    const client = this.createClient(apiKey);
    return this.execute(async () => {
      const result = await client.readers.list(merchantCode);
      return result?.items || [];
    }, 'listReaders');
  }

  async pairReader(apiKey: string, merchantCode: string, pairingCode: string, name: string): Promise<SumUp.Readers.Reader> {
    const client = this.createClient(apiKey);
    return this.execute(
      () => client.readers.create(merchantCode, { pairing_code: pairingCode, name }),
      'pairReader',
    );
  }

  async getReaderStatus(apiKey: string, merchantCode: string, readerId: string): Promise<SumUp.Readers.StatusResponse> {
    const client = this.createClient(apiKey);
    return this.execute(
      () => client.readers.getStatus(merchantCode, readerId),
      'getReaderStatus',
    );
  }

  async updateReader(apiKey: string, merchantCode: string, readerId: string, name: string): Promise<SumUp.Readers.Reader> {
    const client = this.createClient(apiKey);
    return this.execute(
      () => client.readers.update(merchantCode, readerId, { name }),
      'updateReader',
    );
  }

  async deleteReader(apiKey: string, merchantCode: string, readerId: string): Promise<void> {
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
    data: { amount: number; currency: string; affiliateKey?: string; appId?: string },
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
        () => client.readers.createCheckout(merchantCode, readerId, checkoutRequest),
        'initiateCheckout',
      );
    } catch (error: unknown) {
      // If reader is busy from a previous checkout, terminate and retry once
      const errMsg = error instanceof BadRequestException
        ? (error.getResponse() as any)?.errorType
        : undefined;

      if (errMsg === 'READER_BUSY') {
        this.logger.log('Reader busy — terminating previous checkout and retrying...');
        try {
          await client.readers.terminateCheckout(merchantCode, readerId, {});
          // Wait for the reader to process the termination
          await new Promise((resolve) => setTimeout(resolve, 2000));
        } catch (termErr) {
          this.logger.warn(`Failed to terminate previous checkout: ${termErr}`);
        }

        return this.execute(
          () => client.readers.createCheckout(merchantCode, readerId, checkoutRequest),
          'initiateCheckout (retry after terminate)',
        );
      }

      throw error;
    }
  }

  async terminateCheckout(apiKey: string, merchantCode: string, readerId: string): Promise<void> {
    const client = this.createClient(apiKey);
    this.logger.log(`Terminating checkout on reader ${readerId}...`);
    await this.execute(
      () => client.readers.terminateCheckout(merchantCode, readerId, {}),
      'terminateCheckout',
    );
    this.logger.log(`Terminate checkout request sent successfully for reader ${readerId}`);
  }

  async createOnlineCheckout(
    apiKey: string,
    merchantCode: string,
    data: {
      amount: number;
      currency: string;
      description: string;
      checkoutReference: string;
      returnUrl: string;
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
        return_url: data.returnUrl,
        pay_to_email: merchantCode,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`SumUp online checkout failed: ${error}`);
      throw new BadRequestException({
        code: ErrorCodes.SUMUP_API_ERROR,
        message: `SumUp online checkout failed: ${response.status}`,
      });
    }

    const result = await response.json() as { id: string; checkout_url?: string };
    return {
      id: result.id,
      checkoutUrl: result.checkout_url || `https://pay.sumup.com/b2c/checkout/${result.id}`,
    };
  }
}
