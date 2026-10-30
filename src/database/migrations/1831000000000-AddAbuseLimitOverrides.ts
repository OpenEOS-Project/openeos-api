import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Eigene Obergrenzen je Benutzer und Organisation fuer die
 * Missbrauchsschranken (Organisationen je Benutzer, Mitglieder je
 * Organisation). NULL heisst "Standard aus der Umgebung", 0 "unbegrenzt".
 *
 * Nur Erweiterung (expand): zwei NULL-Spalten, der bisherige Code kommt
 * ohne sie aus.
 */
export class AddAbuseLimitOverrides1831000000000 implements MigrationInterface {
  name = 'AddAbuseLimitOverrides1831000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "organization_limit" integer NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "organizations"
        ADD COLUMN IF NOT EXISTS "member_limit" integer NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP COLUMN IF EXISTS "member_limit"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "organization_limit"`,
    );
  }
}
