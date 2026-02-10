import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEventStatusScheduled1770000000000 implements MigrationInterface {
  name = 'AddEventStatusScheduled1770000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ALTER TYPE ADD VALUE cannot run inside a transaction in PostgreSQL
    await queryRunner.commitTransaction();
    await queryRunner.query(`
      ALTER TYPE "event_status" ADD VALUE IF NOT EXISTS 'scheduled' BEFORE 'active';
    `);
    await queryRunner.startTransaction();
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL does not support removing enum values directly.
    // To revert, you would need to recreate the type without the value.
    // This is left as a no-op since removing enum values is destructive.
    // Any events with status 'scheduled' should be updated first.
    await queryRunner.query(`
      UPDATE events SET status = 'draft' WHERE status = 'scheduled';
    `);
  }
}
