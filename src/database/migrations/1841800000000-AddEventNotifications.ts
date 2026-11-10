import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Erinnerungen zu Veranstaltungen an die Admins einer Organisation
 * (EventNotificationsService):
 *
 * - `event_notifications`: eine Zeile je verschickter (oder bewusst
 *   uebersprungener) Mail. `schedule_key` ist der Kalendertag, auf den sich
 *   die Mail bezieht (erster bzw. letzter Veranstaltungstag in der Zeitzone
 *   der Organisation). Wird die Veranstaltung auf einen anderen Tag
 *   verschoben, passt die alte Zeile nicht mehr — die Mail geht fuer den
 *   neuen Termin noch einmal raus. Der eindeutige Index macht jeden Versand
 *   idempotent, auch mit mehreren API-Instanzen. Keine Empfaengeradressen,
 *   nur die Anzahl.
 * - `printers.last_test_print_at`: wann zuletzt ein Testdruck an den
 *   Drucker geschickt wurde — fuer die Checkliste vor dem Fest.
 */
export class AddEventNotifications1841800000000 implements MigrationInterface {
  name = 'AddEventNotifications1841800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS event_notifications (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
         organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
         kind varchar(20) NOT NULL,
         schedule_key varchar(20) NOT NULL,
         status varchar(20) NOT NULL DEFAULT 'sending',
         skip_reason varchar(40) NULL,
         recipients int NOT NULL DEFAULT 0,
         sent_at timestamp with time zone NULL,
         created_at timestamp with time zone NOT NULL DEFAULT now(),
         CONSTRAINT "CHK_event_notifications_kind"
           CHECK (kind IN ('week_before', 'day_before', 'after_event', 'not_booked')),
         CONSTRAINT "CHK_event_notifications_status"
           CHECK (status IN ('sending', 'sent', 'skipped'))
       )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_event_notifications_event_kind_key"
         ON event_notifications (event_id, kind, schedule_key)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_event_notifications_organization"
         ON event_notifications (organization_id)`,
    );
    await queryRunner.query(
      `ALTER TABLE printers ADD COLUMN IF NOT EXISTS last_test_print_at timestamp with time zone NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE printers DROP COLUMN IF EXISTS last_test_print_at`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS event_notifications`);
  }
}
