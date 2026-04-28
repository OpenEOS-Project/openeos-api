import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropWorkflowTables1774000000000 implements MigrationInterface {
  name = 'DropWorkflowTables1774000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "workflow_event" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "workflow_run" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "workflow" CASCADE`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Workflow tables are not recreated — the feature has been removed.
    // If you need to revert, restore from a backup.
  }
}
