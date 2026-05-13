import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddJobRequiredWorkers1789000000000 implements MigrationInterface {
  name = 'AddJobRequiredWorkers1789000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Job-level default for required helpers per shift. Existing jobs keep
    // the previous behaviour by inheriting the shift-level value (default 1).
    await queryRunner.query(
      `ALTER TABLE "shift_jobs" ADD COLUMN IF NOT EXISTS "required_workers" int NOT NULL DEFAULT 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "shift_jobs" DROP COLUMN IF EXISTS "required_workers"`);
  }
}
