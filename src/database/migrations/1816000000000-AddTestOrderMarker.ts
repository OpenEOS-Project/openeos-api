import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kennzeichen fuer Testbuchungen.
 *
 * Bestellungen und Pfand-Rueckgaben, die entstehen, waehrend die
 * Veranstaltung im Testmodus steht, bekommen `is_test = true`. Beim
 * Aktivieren der Veranstaltung werden genau diese Zeilen geloescht —
 * Oberflaeche, Doku und AGB versprechen das.
 *
 * Bestand: Bisher gab es kein Kennzeichen. Als Testbuchung gilt deshalb,
 * was zu einer Veranstaltung gehoert, die gerade im Testmodus steht — das
 * ist genau die Menge, fuer die die Kasse „Bestellungen werden beim
 * Aktivieren geloescht“ angezeigt hat. Ausgenommen sind Bestellungen, deren
 * Bon nachweislich ausserhalb des Testmodus gedruckt wurde
 * (`payload.is_test = false`): die stammen aus einer frueheren aktiven
 * Phase und bleiben. Bestellungen aktiver oder inaktiver Veranstaltungen
 * bleiben unangetastet.
 */
export class AddTestOrderMarker1816000000000 implements MigrationInterface {
  name = 'AddTestOrderMarker1816000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "is_test" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "pfand_returns" ADD COLUMN IF NOT EXISTS "is_test" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_orders_event_test" ON "orders" ("event_id") WHERE "is_test"`,
    );

    await queryRunner.query(`
      UPDATE "orders" o SET "is_test" = true
      FROM "events" e
      WHERE o."event_id" = e."id"
        AND e."status" = 'test'
        AND NOT EXISTS (
          SELECT 1 FROM "print_jobs" pj
          WHERE pj."order_id" = o."id"
            AND pj."payload"->>'is_test' = 'false'
        )
    `);
    await queryRunner.query(`
      UPDATE "pfand_returns" pr SET "is_test" = true
      FROM "events" e
      WHERE pr."event_id" = e."id"
        AND e."status" = 'test'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_orders_event_test"`);
    await queryRunner.query(
      `ALTER TABLE "pfand_returns" DROP COLUMN IF EXISTS "is_test"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "is_test"`,
    );
  }
}
