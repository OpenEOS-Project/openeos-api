import { TseTransactionData } from '../../database/entities/payment.entity';

export interface TseFiskalyConfig {
  apiKey: string;
  apiSecret: string;
  tssId: string;
}

export interface TseTransactionInput {
  clientId: string;
  amount: number;
  currency: string;
  paymentMethod: string;
}

/** Result of a signed transaction, before the `failed` outage flag is applied. */
export type TseTransactionResult = Omit<TseTransactionData, 'failed' | 'failureReason'>;

export interface TseProvider {
  readonly name: 'fiskaly' | 'none';

  /** Idempotently register `clientId` as a till on the TSS. */
  ensureClient(config: TseFiskalyConfig, clientId: string): Promise<void>;

  /**
   * Sign one completed sale as an immediate (start+finish) transaction. Split
   * payments and multi-step baskets each get their own signed transaction —
   * KassenSichV requires the TSE to cover the "Geschäftsvorfall" but does not
   * mandate a single transaction span multiple payments.
   */
  recordTransaction(
    config: TseFiskalyConfig,
    input: TseTransactionInput,
  ): Promise<TseTransactionResult>;

  testConnection(config: TseFiskalyConfig): Promise<{ ok: boolean; message?: string }>;
}
