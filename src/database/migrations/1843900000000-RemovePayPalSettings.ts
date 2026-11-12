import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PayPal ist entfernt (1.8): gespeicherte PayPal-Zugangsdaten der Vereine
 * loeschen — `settings.paypal` (Client-ID, verschluesseltes Client-Secret)
 * und `settings.integrations.paypal`. Zum Loeschen braucht es keinen
 * Schluessel. Mehrfach ausfuehrbar: Organisationen ohne diese Abschnitte
 * bleiben unberuehrt. Was eine alte Instanz waehrend des Rollouts noch
 * schreibt, raeumt der Abgleich nach dem Start nach
 * (`IntegrationCredentialsBackfillService`, removed-settings.util.ts).
 *
 * Zahlungen und Erstattungen mit der Zahlart PayPal bleiben, wie sie sind
 * (Berichte, Exporte, DSFinV-K, Nachdruck); die Enum-Werte `paypal` /
 * `PAYPAL` bleiben deshalb bestehen.
 *
 * down() leer: geloeschte Zugangsdaten lassen sich nicht wiederherstellen,
 * und ohne PayPal-Anbindung braucht sie niemand.
 */
export class RemovePayPalSettings1843900000000 implements MigrationInterface {
  name = 'RemovePayPalSettings1843900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE organizations
         SET settings = (settings - 'paypal')
             || CASE
                  WHEN jsonb_typeof(settings -> 'integrations') = 'object'
                  THEN jsonb_build_object('integrations', (settings -> 'integrations') - 'paypal')
                  ELSE '{}'::jsonb
                END
       WHERE jsonb_typeof(settings) = 'object'
         AND (settings ? 'paypal'
              OR (jsonb_typeof(settings -> 'integrations') = 'object'
                  AND (settings -> 'integrations') ? 'paypal'))
    `);
  }

  public async down(): Promise<void> {
    // Absichtlich leer, siehe oben.
  }
}
