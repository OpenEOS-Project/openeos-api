import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Erinnerungen vor der endgueltigen Loeschung, geplante Kontoloeschung und
 * Protokoll der Loeschungen durch den Verein selbst:
 *
 * - `retention_notices.reminder_days` / `reminded_at`: zuletzt verschickte
 *   Erinnerung (30, 10 oder 1 Tag vor `due_at`); jede Erinnerung geht
 *   hoechstens einmal raus.
 * - `retention_notices.details`: Zusatzangaben ohne Inhalte, z. B. die
 *   Organisationen, die mit einem Konto geloescht werden
 *   (`account_deletion`).
 * - `users.deletion_due_at`: Termin einer geplanten Kontoloeschung. Bis
 *   dahin kann sich der Benutzer anmelden und exportieren, sonst nichts.
 * - `retention_runs.details`: Kennungen der geloeschten Datensaetze (ohne
 *   Inhalte), `trigger` um `club` erweitert (Loeschung durch den Verein).
 */
export class AddDeletionReminders1840400000000 implements MigrationInterface {
  name = 'AddDeletionReminders1840400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE retention_notices
         ADD COLUMN IF NOT EXISTS reminder_days int NULL,
         ADD COLUMN IF NOT EXISTS reminded_at timestamp with time zone NULL,
         ADD COLUMN IF NOT EXISTS details jsonb NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_due_at timestamp with time zone NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE retention_runs ADD COLUMN IF NOT EXISTS details jsonb NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE retention_runs DROP CONSTRAINT IF EXISTS "CHK_retention_runs_trigger"`,
    );
    await queryRunner.query(
      `ALTER TABLE retention_runs ADD CONSTRAINT "CHK_retention_runs_trigger"
         CHECK (trigger IN ('scheduled', 'manual', 'instruction', 'self_service', 'club'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM retention_runs WHERE trigger = 'club'`,
    );
    await queryRunner.query(
      `ALTER TABLE retention_runs DROP CONSTRAINT IF EXISTS "CHK_retention_runs_trigger"`,
    );
    await queryRunner.query(
      `ALTER TABLE retention_runs ADD CONSTRAINT "CHK_retention_runs_trigger"
         CHECK (trigger IN ('scheduled', 'manual', 'instruction', 'self_service'))`,
    );
    await queryRunner.query(
      `ALTER TABLE retention_runs DROP COLUMN IF EXISTS details`,
    );
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN IF EXISTS deletion_due_at`,
    );
    await queryRunner.query(
      `ALTER TABLE retention_notices
         DROP COLUMN IF EXISTS details,
         DROP COLUMN IF EXISTS reminded_at,
         DROP COLUMN IF EXISTS reminder_days`,
    );
  }
}
