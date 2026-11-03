import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

import { TseConfig } from '../tse.config';
import { SwissbitClient } from './swissbit.client';
import type { CreditTokenCredentials } from './swissbit.types';

/**
 * Haelt den einen SwissbitClient (und damit die Keep-Alive-Verbindungen)
 * fuer den Prozess. Fehler werden mit REQUEST-ID protokolliert, nie mit
 * Zugangsdaten. Tests ersetzen `client` durch ein Double.
 */
@Injectable()
export class SwissbitClientProvider implements OnModuleDestroy {
  private readonly logger = new Logger('Swissbit');
  private instance: SwissbitClient | null = null;

  constructor(private readonly config: TseConfig) {}

  get client(): SwissbitClient {
    if (!this.instance) {
      const s = this.config.settings;
      this.instance = new SwissbitClient({
        baseUrl: s.swissbit.baseUrl,
        vendor:
          s.swissbit.vendorClient && s.swissbit.vendorSecret
            ? {
                client: s.swissbit.vendorClient,
                secret: s.swissbit.vendorSecret,
              }
            : null,
        timeouts: {
          transactionMs: s.timeouts.transactionMs,
          adminMs: s.timeouts.adminMs,
        },
        onError: (error) =>
          this.logger.warn(
            `${error.operation} failed: ${error.errorCode} status=${error.status ?? '-'} REQUEST-ID=${error.requestId} ${error.durationMs ?? '-'}ms`,
          ),
      });
    }
    return this.instance;
  }

  /** Fuer Tests. */
  setClient(client: SwissbitClient): void {
    this.instance = client;
  }

  get credit(): CreditTokenCredentials {
    return {
      clientId: this.config.settings.swissbit.creditClientId,
      secret: this.config.settings.swissbit.creditClientSecret,
    };
  }

  get hasVendorCredentials(): boolean {
    const s = this.config.settings.swissbit;
    return !!s.vendorClient && !!s.vendorSecret;
  }

  onModuleDestroy(): void {
    this.instance?.destroy();
  }
}
