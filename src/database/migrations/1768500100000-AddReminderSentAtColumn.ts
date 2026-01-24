import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReminderSentAtColumn1768500100000 implements MigrationInterface {
  name = 'AddReminderSentAtColumn1768500100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "shift_registrations"
      ADD COLUMN "reminder_sent_at" TIMESTAMP WITH TIME ZONE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "shift_registrations"
      DROP COLUMN "reminder_sent_at"
    `);
  }
}
