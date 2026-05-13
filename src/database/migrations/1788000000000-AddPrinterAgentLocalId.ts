import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPrinterAgentLocalId1788000000000 implements MigrationInterface {
  name = 'AddPrinterAgentLocalId1788000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "printers" ADD COLUMN IF NOT EXISTS "agent_local_id" varchar(64)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_printers_device_local"
       ON "printers" ("device_id", "agent_local_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_printers_device_local"`);
    await queryRunner.query(`ALTER TABLE "printers" DROP COLUMN IF EXISTS "agent_local_id"`);
  }
}
