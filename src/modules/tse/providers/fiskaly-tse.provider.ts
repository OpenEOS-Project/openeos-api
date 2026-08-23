import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { TseFiskalyConfig, TseProvider, TseTransactionInput, TseTransactionResult } from '../tse.interface';

const API_BASE = 'https://kassensichv.io/api/v2';

interface FiskalyAuthResponse {
  access_token: string;
}

interface FiskalySignature {
  value: string;
  algorithm: string;
  public_key: string;
  counter: number;
  time: number;
}

interface FiskalyTx {
  number: number;
  time_start: string;
  time_end?: string;
  state: 'ACTIVE' | 'FINISHED' | 'CANCELLED';
  qr_code_data?: string;
  signature?: FiskalySignature;
}

interface FiskalyTss {
  serial_number: string;
}

/**
 * fiskaly Cloud TSE (kassensichv.io) — a cloud-hosted TSE certified under
 * KassenSichV. This talks to the real REST API, but the request/response
 * shapes here follow fiskaly's v2 docs as of this writing; verify against a
 * provisioned TSS before relying on it in production, since fiskaly does
 * version their schema (`schema/version`) and this integrates against
 * "Kassenbeleg-V1" only.
 */
@Injectable()
export class FiskalyTseProvider implements TseProvider {
  readonly name = 'fiskaly' as const;
  private readonly logger = new Logger(FiskalyTseProvider.name);
  private tokenCache = new Map<string, { token: string; expiresAt: number }>();

  private async getAccessToken(config: TseFiskalyConfig): Promise<string> {
    const cached = this.tokenCache.get(config.apiKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.token;
    }

    const res = await fetch(`${API_BASE}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: config.apiKey, api_secret: config.apiSecret }),
    });
    if (!res.ok) {
      throw new Error(`fiskaly auth failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as FiskalyAuthResponse;
    // JWTs from fiskaly are typically valid ~55min; refresh well before that.
    this.tokenCache.set(config.apiKey, { token: data.access_token, expiresAt: Date.now() + 45 * 60 * 1000 });
    return data.access_token;
  }

  private async request<T>(
    config: TseFiskalyConfig,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = await this.getAccessToken(config);
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`fiskaly ${method} ${path} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  async ensureClient(config: TseFiskalyConfig, clientId: string): Promise<void> {
    // PUT is idempotent on fiskaly's client resource — safe to call every time.
    await this.request(config, 'PUT', `/tss/${config.tssId}/client/${clientId}`, {
      serial_number: clientId,
    });
  }

  async recordTransaction(
    config: TseFiskalyConfig,
    input: TseTransactionInput,
  ): Promise<TseTransactionResult> {
    const txId = randomUUID();

    await this.request<FiskalyTx>(config, 'PUT', `/tss/${config.tssId}/tx/${txId}?tx_revision=1`, {
      state: 'ACTIVE',
      client_id: input.clientId,
    });

    const finished = await this.request<FiskalyTx>(
      config,
      'PUT',
      `/tss/${config.tssId}/tx/${txId}?tx_revision=2&last_revision=1`,
      {
        state: 'FINISHED',
        client_id: input.clientId,
        schema: {
          standard_v1: {
            receipt: {
              receipt_type: 'RECEIPT',
              amounts_per_vat_rate: [{ vat_rate: 'NORMAL', amount: input.amount.toFixed(2) }],
              amounts_per_payment_type: [
                { payment_type: mapPaymentType(input.paymentMethod), amount: input.amount.toFixed(2) },
              ],
            },
          },
        },
      },
    );

    const tss = await this.request<FiskalyTss>(config, 'GET', `/tss/${config.tssId}`);

    const signature = finished.signature;
    if (!signature) {
      throw new Error('fiskaly response missing signature — transaction did not finish cleanly');
    }

    return {
      provider: 'fiskaly',
      clientId: input.clientId,
      transactionNumber: finished.number,
      serialNumber: tss.serial_number,
      signatureCounter: signature.counter,
      signatureValue: signature.value,
      signatureAlgorithm: signature.algorithm,
      startTime: finished.time_start,
      endTime: finished.time_end ?? new Date().toISOString(),
      processType: 'Kassenbeleg-V1',
      processData: JSON.stringify({ amount: input.amount, currency: input.currency }),
      qrCodeData:
        finished.qr_code_data ??
        buildQrCodePayload({
          clientId: input.clientId,
          transactionNumber: finished.number,
          startTime: finished.time_start,
          endTime: finished.time_end ?? new Date().toISOString(),
          serialNumber: tss.serial_number,
          signature,
        }),
    };
  }

  async testConnection(config: TseFiskalyConfig): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.request(config, 'GET', `/tss/${config.tssId}`);
      return { ok: true };
    } catch (error) {
      this.logger.warn(`fiskaly test-connection failed: ${(error as Error).message}`);
      return { ok: false, message: (error as Error).message };
    }
  }
}

function mapPaymentType(method: string): 'CASH' | 'NON_CASH' {
  return method === 'cash' ? 'CASH' : 'NON_CASH';
}

/**
 * DSFinV-K TSE-QR-code payload (fallback if the provider doesn't hand back a
 * pre-built one): V0;client;tx-number;start;end;serial;sig-value;sig-counter;
 * sig-algorithm;process-type — semicolon-delimited per the technical guideline.
 */
function buildQrCodePayload(data: {
  clientId: string;
  transactionNumber: number;
  startTime: string;
  endTime: string;
  serialNumber: string;
  signature: FiskalySignature;
}): string {
  return [
    'V0',
    data.clientId,
    data.transactionNumber,
    data.startTime,
    data.endTime,
    data.serialNumber,
    data.signature.value,
    data.signature.counter,
    data.signature.algorithm,
    'Kassenbeleg-V1',
  ].join(';');
}
