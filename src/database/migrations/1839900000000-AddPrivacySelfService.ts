import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Datenschutz zum Selbstbedienen:
 *
 * - `users.newsletter_opt_out_at`: Zeitpunkt des Widerrufs der
 *   Newsletter-Einwilligung (Datenschutzerklaerung 4.5, 13.3). Der Zeitpunkt
 *   der Einwilligung (`newsletter_opt_in_at`) bleibt beim Widerruf stehen,
 *   damit sie nachweisbar bleibt.
 * - `email_otp_purpose` um `account_deletion` erweitert (Code per E-Mail
 *   fuer „Konto löschen“ ohne Passwort).
 * - `retention_runs.trigger` um `self_service` erweitert: das Loeschen des
 *   eigenen Kontos steht im Protokoll der Loeschlaeufe.
 */
export class AddPrivacySelfService1839900000000 implements MigrationInterface {
  name = 'AddPrivacySelfService1839900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS newsletter_opt_out_at timestamp with time zone NULL`,
    );
    await queryRunner.query(
      `ALTER TYPE email_otp_purpose ADD VALUE IF NOT EXISTS 'account_deletion'`,
    );
    await queryRunner.query(
      `ALTER TABLE retention_runs DROP CONSTRAINT IF EXISTS "CHK_retention_runs_trigger"`,
    );
    await queryRunner.query(
      `ALTER TABLE retention_runs ADD CONSTRAINT "CHK_retention_runs_trigger"
         CHECK (trigger IN ('scheduled', 'manual', 'instruction', 'self_service'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM retention_runs WHERE trigger = 'self_service'`,
    );
    await queryRunner.query(
      `ALTER TABLE retention_runs DROP CONSTRAINT IF EXISTS "CHK_retention_runs_trigger"`,
    );
    await queryRunner.query(
      `ALTER TABLE retention_runs ADD CONSTRAINT "CHK_retention_runs_trigger"
         CHECK (trigger IN ('scheduled', 'manual', 'instruction'))`,
    );
    // Enum-Werte lassen sich in Postgres nicht entfernen; offene Codes
    // dieses Zwecks werden ungueltig gemacht.
    await queryRunner.query(
      `UPDATE email_otps SET used_at = now()
        WHERE purpose::text = 'account_deletion' AND used_at IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN IF EXISTS newsletter_opt_out_at`,
    );
  }
}
