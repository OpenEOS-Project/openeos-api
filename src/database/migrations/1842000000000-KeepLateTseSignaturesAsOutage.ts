import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Signatur nach Belegausgabe (Steuerberater 2026-11-10, Frage 16).
 *
 * Bisher hat der Abgleich eine verlorene Antwort der TSE (Zeitlimit bei
 * `finishTransaction`, Signatur erst spaeter per
 * `getLastTransactionResponse` gefunden) als `signed` uebernommen. Der Bon
 * war zu dem Zeitpunkt aber schon ohne Signatur ausgegeben — er ist ein
 * Ausfallbeleg (AEAO zu § 146a Nr. 2.2.3.3, 2.5.2). Seitdem bleibt der
 * Vorgang `failed`; die Signatur wird gespeichert und in der DSFinV-K mit
 * `TSE_TA_FEHLER` „Signatur nach Belegausgabe“ gekennzeichnet.
 *
 * Bestand: noch nicht abgeschlossene Vorgaenge (`cash_point_closing_id IS
 * NULL`) mit `recovered_at` zurueck auf `failed`, damit der naechste
 * Kassenabschluss sie so fuehrt, wie der Bon gedruckt wurde.
 * Abgeschlossene Abschluesse sind unveraenderlich und bleiben, wie sie sind
 * (ihr `BON_NOTIZ` nennt die nachtraegliche Signatur bereits).
 */
export class KeepLateTseSignaturesAsOutage1842000000000 implements MigrationInterface {
  name = 'KeepLateTseSignaturesAsOutage1842000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE tse_transactions
         SET status = 'failed',
             error_code = COALESCE(error_code, 'E_TIMEOUT')
       WHERE recovered_at IS NOT NULL
         AND status IN ('signed', 'training')
         AND cash_point_closing_id IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE tse_transactions
         SET status = CASE WHEN training THEN 'training' ELSE 'signed' END
       WHERE recovered_at IS NOT NULL
         AND status = 'failed'
         AND signature_value IS NOT NULL
         AND cash_point_closing_id IS NULL
    `);
  }
}
