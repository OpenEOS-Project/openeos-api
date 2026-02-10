import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import SumUp from '@sumup/sdk';
import { ErrorCodes } from '../../common/constants/error-codes';

@Injectable()
export class SumUpApiService {
  private readonly logger = new Logger(SumUpApiService.name);

  private createClient(apiKey: string): SumUp {
    return new SumUp({ apiKey });
  }

  private async execute<T>(fn: () => Promise<T>, context: string): Promise<T> {
    try {
      return await fn();
    } catch (error: unknown) {
      if (error instanceof BadRequestException || error instanceof InternalServerErrorException) {
        throw error;
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(`SumUp API error [${context}]: ${message}`);

      throw new BadRequestException({
        code: ErrorCodes.SUMUP_API_ERROR,
        message: `SumUp: ${message}`,
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

    return this.execute(
      () => client.readers.createCheckout(merchantCode, readerId, checkoutRequest),
      'initiateCheckout',
    );
  }

  async terminateCheckout(apiKey: string, merchantCode: string, readerId: string): Promise<void> {
    const client = this.createClient(apiKey);
    return this.execute(
      () => client.readers.terminateCheckout(merchantCode, readerId),
      'terminateCheckout',
    );
  }
}
