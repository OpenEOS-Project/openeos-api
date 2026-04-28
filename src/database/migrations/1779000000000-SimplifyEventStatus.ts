import { MigrationInterface, QueryRunner } from 'typeorm';

export class SimplifyEventStatus1779000000000 implements MigrationInterface {
  name = 'SimplifyEventStatus1779000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ALTER TYPE ADD VALUE cannot run inside a transaction in PostgreSQL
    await queryRunner.commitTransaction();

    await queryRunner.query(`ALTER TYPE "event_status" ADD VALUE IF NOT EXISTS 'inactive'`);
    await queryRunner.query(`ALTER TYPE "event_status" ADD VALUE IF NOT EXISTS 'test'`);

    await queryRunner.startTransaction();

    // Migrate existing data: draft/completed/cancelled → inactive, scheduled → active
    await queryRunner.query(`UPDATE events SET status = 'inactive' WHERE status IN ('draft', 'completed', 'cancelled')`);
    await queryRunner.query(`UPDATE events SET status = 'active' WHERE status = 'scheduled'`);

    // Make startDate and endDate nullable
    await queryRunner.query(`ALTER TABLE events ALTER COLUMN start_date DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE events ALTER COLUMN end_date DROP NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Revert data migration (best effort — old enum values cannot be re-added to the type)
    await queryRunner.query(`UPDATE events SET status = 'draft' WHERE status = 'inactive'`);
    await queryRunner.query(`UPDATE events SET status = 'draft' WHERE status = 'test'`);

    // Restore NOT NULL constraints (may fail if any rows have NULL dates)
    await queryRunner.query(`ALTER TABLE events ALTER COLUMN start_date SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE events ALTER COLUMN end_date SET NOT NULL`);
  }
}
