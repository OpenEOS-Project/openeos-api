import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Abgerechnete Veranstaltungstage je Veranstaltung festhalten.
 *
 * Abgerechnet wird ab jetzt nach Geschaeftstagen (6 bis 6 Uhr) statt nach
 * Kalendertagen. Was schon bezahlt oder auf Rechnung bestellt ist, wurde
 * nach der alten Regel berechnet und soll so bleiben: Bestandszeilen
 * bekommen die Kalendertage in der Zeitzone ihrer Organisation — genau die
 * Zahl, die beim Bezahlen galt (countCalendarDays). Alles andere bleibt
 * leer und wird beim Freischalten gesetzt.
 */
export class AddEventBilledDays1819000000000 implements MigrationInterface {
  name = 'AddEventBilledDays1819000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "billed_days" integer`,
    );

    /* Eine unbekannte Zeitzone in den Einstellungen liesse AT TIME ZONE
       scheitern und mit ihr die ganze Migration — dann gilt, wie im Code,
       Europe/Berlin. */
    await queryRunner.query(`
      WITH zone AS (
        SELECT o."id",
               CASE WHEN o."settings"->>'timezone' IN (SELECT "name" FROM pg_timezone_names)
                    THEN o."settings"->>'timezone'
                    ELSE 'Europe/Berlin'
               END AS tz
        FROM "organizations" o
      )
      UPDATE "events" e SET "billed_days" = GREATEST(
        1,
        ((COALESCE(e."end_date", e."start_date") AT TIME ZONE zone.tz)::date
          - (e."start_date" AT TIME ZONE zone.tz)::date) + 1
      )
      FROM zone
      WHERE zone."id" = e."organization_id"
        AND e."billing_status" IN ('paid', 'invoice')
        AND e."billed_days" IS NULL
        AND e."start_date" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "events" DROP COLUMN IF EXISTS "billed_days"`,
    );
  }
}
