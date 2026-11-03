import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { join } from 'path';

export type TseProviderName = 'none' | 'swissbit';
export type TseLifecycle = 'persistent' | 'per_event';

/** Produktions-URL der Swissbit Cloud-TSE 2 (Dev: https://dev.web-tse.de). */
export const SWISSBIT_PROD_URL = 'https://web-tse.de';

export interface TseSettings {
  provider: TseProviderName;
  lifecycle: TseLifecycle;
  swissbit: {
    baseUrl: string;
    vendorClient: string;
    vendorSecret: string;
    creditClientId: string;
    creditClientSecret: string;
    productType: string;
  };
  /** Absoluter Pfad fuer TAR-Exporte (nicht oeffentlich). */
  exportDir: string;
  timeouts: {
    transactionMs: number;
    signBudgetMs: number;
    adminMs: number;
  };
}

/** Leer oder nur Leerzeichen = nicht gesetzt (compose `${VAR:-}`). */
function value(env: Record<string, string | undefined>, key: string): string {
  return (env[key] ?? '').trim();
}

function intValue(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = value(env, key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function tseSettingsFromEnv(
  env: Record<string, string | undefined>,
): TseSettings {
  const provider =
    value(env, 'TSE_PROVIDER') === 'swissbit' ? 'swissbit' : 'none';
  const lifecycle =
    value(env, 'TSE_LIFECYCLE') === 'per_event' ? 'per_event' : 'persistent';
  const uploadDir = value(env, 'UPLOAD_DIR') || './uploads';
  const exportDir =
    value(env, 'TSE_EXPORT_DIR') || join(uploadDir, 'tse-exports');
  return {
    provider,
    lifecycle,
    swissbit: {
      baseUrl: value(env, 'SWISSBIT_BASE_URL') || SWISSBIT_PROD_URL,
      vendorClient: value(env, 'SWISSBIT_VENDOR_CLIENT'),
      vendorSecret: value(env, 'SWISSBIT_VENDOR_SECRET'),
      creditClientId: value(env, 'SWISSBIT_CREDIT_CLIENT_ID'),
      creditClientSecret: value(env, 'SWISSBIT_CREDIT_CLIENT_SECRET'),
      productType: value(env, 'SWISSBIT_PRODUCT_TYPE'),
    },
    exportDir: join(
      exportDir.startsWith('/') ? '' : process.cwd(),
      exportDir.replace(/^\.\//, ''),
    ),
    timeouts: {
      transactionMs: intValue(env, 'TSE_TX_TIMEOUT_MS', 5_000),
      signBudgetMs: intValue(env, 'TSE_SIGN_BUDGET_MS', 8_000),
      adminMs: intValue(env, 'TSE_ADMIN_TIMEOUT_MS', 15_000),
    },
  };
}

/**
 * Konfiguration der Cloud-TSE fuer die Nest-Welt. `enabled` heisst: der
 * Betreiber hat Swissbit eingerichtet (Provider + Credit Token +
 * Produkttyp). Ohne das bieten Oberflaeche und API keine TSE an
 * (503 TSE_NOT_AVAILABLE beim Anlegen).
 */
@Injectable()
export class TseConfig {
  readonly settings: TseSettings;

  constructor(configService: ConfigService) {
    const keys = [
      'TSE_PROVIDER',
      'TSE_LIFECYCLE',
      'SWISSBIT_BASE_URL',
      'SWISSBIT_VENDOR_CLIENT',
      'SWISSBIT_VENDOR_SECRET',
      'SWISSBIT_CREDIT_CLIENT_ID',
      'SWISSBIT_CREDIT_CLIENT_SECRET',
      'SWISSBIT_PRODUCT_TYPE',
      'TSE_EXPORT_DIR',
      'UPLOAD_DIR',
      'TSE_TX_TIMEOUT_MS',
      'TSE_SIGN_BUDGET_MS',
      'TSE_ADMIN_TIMEOUT_MS',
    ];
    const env: Record<string, string | undefined> = {};
    for (const key of keys) {
      const raw = configService.get<string | number>(key);
      env[key] = raw === undefined || raw === null ? undefined : String(raw);
    }
    this.settings = tseSettingsFromEnv(env);
  }

  get enabled(): boolean {
    const s = this.settings;
    return (
      s.provider === 'swissbit' &&
      !!s.swissbit.creditClientId &&
      !!s.swissbit.creditClientSecret &&
      !!s.swissbit.productType
    );
  }

  get lifecycle(): TseLifecycle {
    return this.settings.lifecycle;
  }
}
