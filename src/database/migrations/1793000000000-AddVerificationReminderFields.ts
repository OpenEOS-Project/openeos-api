import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVerificationReminderFields1793000000000 implements MigrationInterface {
  name = 'AddVerificationReminderFields1793000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Bookkeeping for the verification-reminder cron: how many reminders has
    // this row received, and when did the last one go out? The cron uses
    // both to decide whether to send another or to give up.
    await queryRunner.query(`
      ALTER TABLE "shift_registrations"
        ADD COLUMN IF NOT EXISTS "verification_reminder_count" int NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "last_verification_reminder_at" TIMESTAMPTZ NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "shift_registrations"
        DROP COLUMN IF EXISTS "last_verification_reminder_at",
        DROP COLUMN IF EXISTS "verification_reminder_count"
    `);
  }
}
