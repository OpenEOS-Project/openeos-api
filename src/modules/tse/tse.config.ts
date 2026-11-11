import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { join } from 'path';

export type TseProviderName = 'none' | 'swissbit';
/**
 * - `monthly` (Standard): die TSE laeuft fuer den Kalendermonat ihrer
 *   Veranstaltung und wird zum Monatsende automatisch abgemeldet
 *   (tse-monthly.ts). Der fruehere Wert `per_event` gilt als `monthly`.
 * - `persistent`: einmal angelegt, bleibt die TSE aktiv.
 */
export type TseLifecycle = 'persistent' | 'monthly';

/**
 * Bietet dieser Server die Cloud-TSE an?
 * - `available`: eingerichtet (Provider + Zugangsdaten), siehe `enabled`,
 * - `coming_soon`: gehostete Installation, die die Cloud-TSE ankuendigt,
 *   aber noch nicht anbietet (`TSE_COMING_SOON=true`) — die Oberflaeche
 *   zeigt „Bald verfuegbar“ statt „nicht eingerichtet“,
 * - `not_configured`: keine Cloud-TSE (eigene Installation ohne Provider).
 *
 * Ausdruecklich gesetzt statt abgeleitet: „kein Provider“ allein sagt
 * nicht, ob die TSE kommt (gehostet) oder nie eingerichtet wird.
 */
export type TseAvailability = 'available' | 'coming_soon' | 'not_configured';

export function tseAvailabilityOf(input: {
  enabled: boolean;
  comingSoon: boolean;
  selfHosted: boolean;
}): TseAvailability {
  if (input.enabled) return 'available';
  // Eigene Installationen kuendigt OpenEOS nichts an — dort entscheidet
  // der Betreiber, ob er eine TSE einrichtet.
  if (input.comingSoon && !input.selfHosted) return 'coming_soon';
  return 'not_configured';
}

/** Meldung zu 503 TSE_NOT_AVAILABLE je nach Verfuegbarkeit. */
export function tseNotAvailableMessage(availability: TseAvailability): string {
  return availability === 'coming_soon'
    ? 'Die Cloud-TSE ist bald verfügbar. Bis dahin kannst du „Nur Bons“ oder „Bargeldlos“ nutzen.'
    : 'Auf diesem Server ist keine Cloud-TSE eingerichtet';
}

/** `TSE_COMING_SOON` lesen: nur `true` (Gross/klein egal) schaltet ein. */
export function parseTseComingSoon(raw: string | undefined): boolean {
  return (raw ?? '').trim().toLowerCase() === 'true';
}

/** `TSE_LIFECYCLE` lesen: `persistent` oder (Standard, auch `per_event`) `monthly`. */
export function parseTseLifecycle(raw: string): TseLifecycle {
  return raw.trim().toLowerCase() === 'persistent' ? 'persistent' : 'monthly';
}

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
    /**
     * Budget fuer das Absichern einer Bestellung vor dem Kuechenbon,
     * solange ein TSE-Ausfall offen ist (Standard 1500 ms). Die Kueche soll
     * bei einem bekannten Ausfall nicht jedes Mal das volle Budget warten.
     */
    outageOrderBudgetMs?: number;
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
  const lifecycle = parseTseLifecycle(value(env, 'TSE_LIFECYCLE'));
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
      outageOrderBudgetMs: intValue(env, 'TSE_OUTAGE_ORDER_BUDGET_MS', 1_500),
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
  /** `TSE_COMING_SOON=true`: die Cloud-TSE als „Bald verfuegbar“ zeigen. */
  readonly comingSoon: boolean;
  private readonly selfHosted: boolean;

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
    const comingSoon = configService.get<string | boolean>('TSE_COMING_SOON');
    this.comingSoon = parseTseComingSoon(
      comingSoon === undefined || comingSoon === null
        ? undefined
        : String(comingSoon),
    );
    this.selfHosted =
      configService.get<string>('deployment.mode') === 'selfhosted';
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

  /** Fuer Oberflaeche und Status: verfuegbar, bald verfuegbar oder nicht. */
  get availability(): TseAvailability {
    return tseAvailabilityOf({
      enabled: this.enabled,
      comingSoon: this.comingSoon,
      selfHosted: this.selfHosted,
    });
  }

  get lifecycle(): TseLifecycle {
    return this.settings.lifecycle;
  }
}
