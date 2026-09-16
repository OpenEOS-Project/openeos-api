import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Konten ohne Passwort.
 *
 * Wer sich per Anmeldelink registriert, bekommt keines. Die Spalte muss
 * deshalb leer bleiben duerfen — ein Platzhalter-Hash waere schlechter:
 * er sieht aus wie ein Passwort, gehoert aber niemandem, und jede
 * Pruefung muesste ihn gesondert kennen.
 */
export class AllowPasswordlessAccounts1807000000000 implements MigrationInterface {
  name = 'AllowPasswordlessAccounts1807000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    /* Zurueck geht nur, wenn kein Konto ohne Passwort existiert — sonst
       schluege das NOT NULL fehl. Die betroffenen Konten bekaemen sonst
       stillschweigend irgendeinen Hash. */
    await queryRunner.query(`
      ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL
    `);
  }
}
