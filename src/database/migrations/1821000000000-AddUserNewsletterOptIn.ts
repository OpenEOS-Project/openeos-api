import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Einwilligung in Produkt-Neuigkeiten aus der Registrierung.
 *
 * Die Checkbox gab es im Registrierungsformular schon, ihr Wert kam aber nie
 * an: weder schickte die Oberflaeche ihn mit, noch kannte die API ein Feld
 * dafuer. Gespeichert wird der Zeitpunkt der Einwilligung als Nachweis;
 * bestehende Konten haben keine (NULL).
 */
export class AddUserNewsletterOptIn1821000000000 implements MigrationInterface {
  name = 'AddUserNewsletterOptIn1821000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS newsletter_opt_in_at timestamp with time zone NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN IF EXISTS newsletter_opt_in_at`,
    );
  }
}
