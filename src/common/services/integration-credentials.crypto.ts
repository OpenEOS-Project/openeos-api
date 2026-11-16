import { Logger } from '@nestjs/common';
import { FindOperator } from 'typeorm';

import { MASKED_CREDENTIALS } from '../utils/response-redaction.util';
import {
  decryptWithKey,
  deriveEncryptionKey,
  encryptWithKey,
} from './encryption.service';

/**
 * Zugangsdaten der Zahlungsanbieter (SumUp) in den
 * Organisationseinstellungen verschluesselt ablegen.
 *
 * Betroffen sind genau die Felder, die die API ohnehin nur maskiert
 * herausgibt (`MASKED_CREDENTIALS`): `sumup.apiKey`, `sumup.affiliateKey`.
 * (Fruehere PayPal-Zugangsdaten sind geloescht, siehe
 * removed-settings.util.ts.) Verfahren wie bei 2FA und TSE (AES-256-GCM,
 * `encryptWithKey`), dazu das Praefix `enc:v1:` — daran erkennt man
 * verschluesselte Werte, und Klartext aus der Zeit davor bleibt lesbar.
 *
 * Schluessel: `INTEGRATION_ENCRYPTION_KEY`, sonst
 * `TWO_FACTOR_ENCRYPTION_KEY` (in Produktion Pflicht, die API startet ohne
 * ihn nicht). Ohne beide ausserhalb der Produktion ein Entwicklungsschluessel
 * mit Warnung — wie TseCryptoService. Entschluesselt wird mit jedem der
 * Schluessel; wer `INTEGRATION_ENCRYPTION_KEY` spaeter setzt, verliert also
 * nichts, der Abgleich beim Start schreibt die Werte dann neu.
 */

export const ENCRYPTED_CREDENTIAL_PREFIX = 'enc:v1:';

/** Abschnitt → Felder, die verschluesselt abgelegt werden. */
export const ENCRYPTED_CREDENTIALS: Readonly<
  Record<string, readonly string[]>
> = MASKED_CREDENTIALS;

const DEV_DEFAULT_SECRET = 'openeos-dev-integration-encryption-key';

export type IntegrationKeySource =
  | 'INTEGRATION_ENCRYPTION_KEY'
  | 'TWO_FACTOR_ENCRYPTION_KEY'
  | 'development-default';

export interface IntegrationKeyEnv {
  INTEGRATION_ENCRYPTION_KEY?: string;
  TWO_FACTOR_ENCRYPTION_KEY?: string;
  NODE_ENV?: string;
}

export function isEncryptedCredential(value: unknown): value is string {
  return (
    typeof value === 'string' && value.startsWith(ENCRYPTED_CREDENTIAL_PREFIX)
  );
}

export class IntegrationKeyring {
  readonly source: IntegrationKeySource;
  private readonly primary: Buffer;
  /** Primaerschluessel zuerst, danach die Rueckfaelle (nur zum Lesen). */
  private readonly candidates: Buffer[];

  constructor(env: IntegrationKeyEnv) {
    const dedicated = (env.INTEGRATION_ENCRYPTION_KEY ?? '').trim();
    const fallback = (env.TWO_FACTOR_ENCRYPTION_KEY ?? '').trim();

    let secret: string;
    if (dedicated) {
      secret = dedicated;
      this.source = 'INTEGRATION_ENCRYPTION_KEY';
    } else if (fallback) {
      secret = fallback;
      this.source = 'TWO_FACTOR_ENCRYPTION_KEY';
    } else {
      if (env.NODE_ENV === 'production') {
        // Ohne Schluessel startet EncryptionService in Produktion ohnehin nicht.
        throw new Error(
          'INTEGRATION_ENCRYPTION_KEY (or TWO_FACTOR_ENCRYPTION_KEY) is not set',
        );
      }
      secret = DEV_DEFAULT_SECRET;
      this.source = 'development-default';
    }

    this.primary = deriveEncryptionKey(secret);
    const seen = new Set<string>([secret]);
    this.candidates = [this.primary];
    for (const other of [fallback, DEV_DEFAULT_SECRET]) {
      if (other && !seen.has(other)) {
        seen.add(other);
        this.candidates.push(deriveEncryptionKey(other));
      }
    }
  }

  encrypt(plaintext: string): string {
    return (
      ENCRYPTED_CREDENTIAL_PREFIX + encryptWithKey(this.primary, plaintext)
    );
  }

  /**
   * Klartext und ob er mit dem aktuellen Schluessel verschluesselt war;
   * `null`, wenn keiner der Schluessel passt (oder der Wert beschaedigt ist).
   */
  decrypt(value: string): { plaintext: string; current: boolean } | null {
    const payload = value.slice(ENCRYPTED_CREDENTIAL_PREFIX.length);
    for (const [index, key] of this.candidates.entries()) {
      try {
        return {
          plaintext: decryptWithKey(key, payload),
          current: index === 0,
        };
      } catch {
        // naechster Schluessel
      }
    }
    return null;
  }
}

const logger = new Logger('IntegrationCredentials');
let keyring: IntegrationKeyring | undefined;

/**
 * Schluesselbund aus der Umgebung, beim ersten Gebrauch angelegt. Die
 * Spalten-Transformation (TypeORM) hat keinen Zugriff auf Nest-DI; die
 * Werte aus `.env` stehen dank ConfigModule aber in `process.env`.
 */
export function getIntegrationKeyring(): IntegrationKeyring {
  if (!keyring) {
    keyring = new IntegrationKeyring({
      INTEGRATION_ENCRYPTION_KEY: process.env.INTEGRATION_ENCRYPTION_KEY,
      TWO_FACTOR_ENCRYPTION_KEY: process.env.TWO_FACTOR_ENCRYPTION_KEY,
      NODE_ENV: process.env.NODE_ENV,
    });
    if (keyring.source === 'development-default') {
      logger.warn(
        'INTEGRATION_ENCRYPTION_KEY not set - using development default. DO NOT USE IN PRODUCTION!',
      );
    }
  }
  return keyring;
}

/** Nur fuer Tests: Schluesselbund nach Aenderung von `process.env` neu lesen. */
export function resetIntegrationKeyring(): void {
  keyring = undefined;
  warnedUndecryptable.clear();
}

const warnedUndecryptable = new Set<string>();

type Settings = Record<string, unknown>;

/**
 * Kopie der Einstellungen mit verschluesselten Zugangsdaten. Bereits
 * verschluesselte Werte (Praefix) bleiben unveraendert — auch solche, die
 * sich gerade nicht entschluesseln lassen, damit sie nicht verloren gehen.
 * Das Original bleibt unberuehrt (es ist meist ein Entity im Speicher).
 */
export function encryptCredentialSettings<T>(
  settings: T,
  ring: IntegrationKeyring = getIntegrationKeyring(),
): T {
  return mapCredentials(settings, (value) =>
    isEncryptedCredential(value) ? value : ring.encrypt(value),
  );
}

/**
 * Kopie der Einstellungen mit Klartext-Zugangsdaten. Klartext aus der Zeit
 * vor der Verschluesselung kommt unveraendert zurueck. Passt kein Schluessel,
 * bleibt der verschluesselte Wert stehen (Warnung einmal je Wert) — so
 * schreibt ihn ein spaeteres Speichern unveraendert zurueck, statt ihn zu
 * verwerfen, und die Antwort zeigt ihn wie jeden Schluessel nur maskiert.
 */
export function decryptCredentialSettings<T>(
  settings: T,
  ring: IntegrationKeyring = getIntegrationKeyring(),
): T {
  return mapCredentials(settings, (value, path) => {
    if (!isEncryptedCredential(value)) return value;
    const result = ring.decrypt(value);
    if (result) return result.plaintext;
    const marker = `${path}:${value.slice(-12)}`;
    if (!warnedUndecryptable.has(marker)) {
      warnedUndecryptable.add(marker);
      logger.error(
        `Stored credential ${path} cannot be decrypted with the configured key (INTEGRATION_ENCRYPTION_KEY / TWO_FACTOR_ENCRYPTION_KEY)`,
      );
    }
    return value;
  });
}

function mapCredentials<T>(
  settings: T,
  map: (value: string, path: string) => string,
): T {
  if (!isPlainObject(settings)) return settings;
  let copy: Settings | undefined;
  for (const [section, fields] of Object.entries(ENCRYPTED_CREDENTIALS)) {
    const block = (settings as Settings)[section];
    if (!isPlainObject(block)) continue;
    let blockCopy: Settings | undefined;
    for (const field of fields) {
      const value = block[field];
      if (typeof value !== 'string' || value.length === 0) continue;
      const mapped = map(value, `${section}.${field}`);
      if (mapped === value) continue;
      blockCopy ??= { ...block };
      blockCopy[field] = mapped;
    }
    if (blockCopy) {
      copy ??= { ...(settings as Settings) };
      copy[section] = blockCopy;
    }
  }
  return (copy ?? settings) as T;
}

/** Objekt mit Feldern — kein Array, Datum, Buffer oder TypeORM-Operator. */
function isPlainObject(value: unknown): value is Settings {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !Buffer.isBuffer(value) &&
    !(value instanceof FindOperator)
  );
}
