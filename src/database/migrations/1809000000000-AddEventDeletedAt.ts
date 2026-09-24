import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `deleted_at` fuer Veranstaltungen.
 *
 * Der Dienst rief seit jeher `softRemove` auf, die Spalte dazu gab es
 * aber nie — jeder Loeschversuch endete mit einem Serverfehler. In Sentry
 * standen dafuer elf Fehlschlaege eines einzelnen Kunden.
 *
 * Weich statt hart geloescht, weil an einer Veranstaltung Bestellungen,
 * Schichtplaene, Bestandsbewegungen und Abrechnungsstaende haengen: ein
 * echtes DELETE nimmt die Geschichte mit.
 */
export class AddEventDeletedAt1809000000000 implements MigrationInterface {
  name = 'AddEventDeletedAt1809000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE events ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone
    `);
    /* Fast jede Abfrage filtert ab jetzt auf "nicht geloescht"; ohne Index
       liefe das ueber die ganze Tabelle. */
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_events_deleted_at ON events (deleted_at)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_events_deleted_at`);
    await queryRunner.query(`ALTER TABLE events DROP COLUMN IF EXISTS deleted_at`);
  }
}
