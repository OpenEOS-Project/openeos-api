import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `menu_imports.error` traegt seit dieser Version nur noch einen kurzen,
 * verstaendlichen Hinweis fuer die Web-App. Die Rohmeldung des Anbieters
 * wandert nach `error_detail` (nur Log/Datenbank, nie an Clients).
 *
 * Nur Erweiterung (expand) — laufende Instanzen der Vorversion kommen
 * mit der zusaetzlichen Spalte zurecht.
 */
export class AddMenuImportErrorDetail1829000000000 implements MigrationInterface {
  name = 'AddMenuImportErrorDetail1829000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "menu_imports" ADD COLUMN IF NOT EXISTS "error_detail" text NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "menu_imports" DROP COLUMN IF EXISTS "error_detail"`,
    );
  }
}
