import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  ENCRYPTED_CREDENTIALS,
  IntegrationKeyring,
  getIntegrationKeyring,
  isEncryptedCredential,
} from '../../common/services/integration-credentials.crypto';

/**
 * Wartezeit nach dem Start bis zum Abgleich. Beim Rollout bedienen alte und
 * neue Instanzen kurz dieselbe Datenbank; eine alte Instanz kennt keine
 * verschluesselten Werte. Erst wenn sie ersetzt ist, wird umgeschrieben.
 */
export const BACKFILL_DELAY_MS = 5 * 60_000;

export interface BackfillResult {
  encrypted: number;
  reencrypted: number;
  undecryptable: number;
}

interface Row {
  id: string;
  settings: Record<string, unknown> | null;
}

/**
 * Verschluesselt Zugangsdaten, die noch im Klartext in
 * `organizations.settings` stehen (Bestand vor der Verschluesselung), und
 * schreibt Werte neu, die noch mit dem Rueckfallschluessel verschluesselt
 * sind (`INTEGRATION_ENCRYPTION_KEY` nachtraeglich gesetzt).
 *
 * Bewusst keine TypeORM-Migration: der `migrate`-Dienst der Vorlage hat
 * keinen Schluessel in der Umgebung, die API schon. Mehrfach ausfuehrbar —
 * verschluesselte Werte erkennt der Abgleich am Praefix. Jedes Feld wird
 * einzeln und nur dann geschrieben, wenn es noch den gelesenen Wert hat;
 * parallel startende Instanzen und gleichzeitiges Speichern ueberschreiben
 * einander so nicht.
 */
@Injectable()
export class IntegrationCredentialsBackfillService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(
    IntegrationCredentialsBackfillService.name,
  );
  private timer: NodeJS.Timeout | undefined;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  onApplicationBootstrap(): void {
    // Schluessel jetzt pruefen, nicht erst beim ersten Laden einer Organisation.
    const ring = getIntegrationKeyring();
    this.logger.log(`Integration credentials key: ${ring.source}`);
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run(ring).catch((error: unknown) => {
        this.logger.error(
          `Integration credentials backfill failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, BACKFILL_DELAY_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async run(
    ring: IntegrationKeyring = getIntegrationKeyring(),
  ): Promise<BackfillResult> {
    const result: BackfillResult = {
      encrypted: 0,
      reencrypted: 0,
      undecryptable: 0,
    };
    const sections = Object.keys(ENCRYPTED_CREDENTIALS);
    // Auch geloeschte Organisationen: deren Daten liegen ebenso in der Tabelle.
    const rows: Row[] = await this.dataSource.query(
      `SELECT id, settings FROM organizations WHERE settings ?| $1::text[]`,
      [sections],
    );

    for (const row of rows) {
      for (const [section, fields] of Object.entries(ENCRYPTED_CREDENTIALS)) {
        const block = row.settings?.[section];
        if (!block || typeof block !== 'object' || Array.isArray(block)) {
          continue;
        }
        for (const field of fields) {
          const stored = (block as Record<string, unknown>)[field];
          if (typeof stored !== 'string' || stored.length === 0) continue;

          let next: string;
          if (isEncryptedCredential(stored)) {
            const decrypted = ring.decrypt(stored);
            if (!decrypted) {
              result.undecryptable++;
              continue;
            }
            if (decrypted.current) continue;
            next = ring.encrypt(decrypted.plaintext);
          } else {
            next = ring.encrypt(stored);
          }

          const updated: unknown[] = await this.dataSource.query(
            `UPDATE organizations
                SET settings = jsonb_set(settings, ARRAY[$2::text, $3::text], to_jsonb($4::text), false)
              WHERE id = $1 AND settings -> $2 ->> $3 = $5
            RETURNING id`,
            [row.id, section, field, next, stored],
          );
          if (rowCount(updated) === 0) continue; // inzwischen geaendert
          if (isEncryptedCredential(stored)) result.reencrypted++;
          else result.encrypted++;
        }
      }
    }

    if (result.encrypted || result.reencrypted) {
      this.logger.log(
        `Integration credentials backfill: ${result.encrypted} encrypted, ${result.reencrypted} re-encrypted with ${ring.source}`,
      );
    }
    if (result.undecryptable) {
      this.logger.error(
        `Integration credentials backfill: ${result.undecryptable} stored value(s) cannot be decrypted with the configured key`,
      );
    }
    return result;
  }
}

/** `query()` liefert bei UPDATE … RETURNING je nach Treiber [rows, count]. */
function rowCount(result: unknown[]): number {
  if (
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[1];
  }
  return result.length;
}
