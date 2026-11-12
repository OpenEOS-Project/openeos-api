import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Zweiter Anmeldeschritt:
 *
 * - `trusted_devices` erkennt ein vertrautes Geraet kuenftig an einem
 *   vom Server ausgegebenen Zufallsgeheimnis (`token_hash`, SHA-256)
 *   statt an Merkmalen, die der Browser selbst meldet. Bestehende
 *   Eintraege lassen sich darauf nicht abbilden und entfallen; betroffene
 *   Benutzer geben beim naechsten Anmelden einmal ihren Code ein.
 *   `device_fingerprint` bleibt als nullbare Spalte stehen, damit eine
 *   aeltere API-Fassung nach einem Zuruecksetzen noch startet.
 *   `token_hash` ist nullbar: waehrend des Austauschs schreibt eine noch
 *   laufende aeltere Instanz Eintraege ohne Hash; die neue Fassung findet
 *   solche Eintraege nie (Suche nur ueber den Hash).
 * - `two_factor_challenges`: ein offener zweiter Schritt je Anmeldung,
 *   mit Fehlversuchen und Ende.
 */
export class TrustedDeviceTokensAndTwoFactorChallenges1843600000000 implements MigrationInterface {
  name = 'TrustedDeviceTokensAndTwoFactorChallenges1843600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "trusted_devices"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_trusted_devices_user_fingerprint"`,
    );
    await queryRunner.query(
      `ALTER TABLE "trusted_devices" ALTER COLUMN "device_fingerprint" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "trusted_devices" ADD "token_hash" varchar(64)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_trusted_devices_token_hash" ON "trusted_devices" ("token_hash")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_trusted_devices_expires_at" ON "trusted_devices" ("expires_at")`,
    );

    await queryRunner.query(`
      CREATE TABLE "two_factor_challenges" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "failed_attempts" int NOT NULL DEFAULT 0,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_two_factor_challenges" PRIMARY KEY ("id"),
        CONSTRAINT "FK_two_factor_challenges_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_two_factor_challenges_user_created" ON "two_factor_challenges" ("user_id", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "two_factor_challenges"`);
    await queryRunner.query(`DELETE FROM "trusted_devices"`);
    await queryRunner.query(`DROP INDEX "IDX_trusted_devices_token_hash"`);
    await queryRunner.query(
      `ALTER TABLE "trusted_devices" DROP COLUMN "token_hash"`,
    );
    await queryRunner.query(
      `ALTER TABLE "trusted_devices" ALTER COLUMN "device_fingerprint" SET NOT NULL`,
    );
  }
}
