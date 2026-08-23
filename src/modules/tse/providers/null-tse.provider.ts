import { Injectable } from '@nestjs/common';
import { TseFiskalyConfig, TseProvider, TseTransactionInput, TseTransactionResult } from '../tse.interface';

/** No-op provider used when an organization has TSE disabled. */
@Injectable()
export class NullTseProvider implements TseProvider {
  readonly name = 'none' as const;

  async ensureClient(): Promise<void> {}

  async recordTransaction(
    _config: TseFiskalyConfig,
    input: TseTransactionInput,
  ): Promise<TseTransactionResult> {
    const now = new Date().toISOString();
    return {
      provider: 'none',
      clientId: input.clientId,
      transactionNumber: 0,
      serialNumber: '',
      signatureCounter: 0,
      signatureValue: '',
      signatureAlgorithm: '',
      startTime: now,
      endTime: now,
      processType: 'Kassenbeleg-V1',
      processData: '',
      qrCodeData: '',
    };
  }

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    return { ok: false, message: 'TSE ist für diese Organisation nicht konfiguriert' };
  }
}
