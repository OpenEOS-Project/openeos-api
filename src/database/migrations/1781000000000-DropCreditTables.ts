import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropCreditTables1781000000000 implements MigrationInterface {
  name = 'DropCreditTables1781000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop child first (FK to credit_packages), then parent.
    await queryRunner.query('DROP TABLE IF EXISTS "credit_purchases" CASCADE');
    await queryRunner.query('DROP TABLE IF EXISTS "credit_packages" CASCADE');
    await queryRunner.query('DROP TABLE IF EXISTS "credit_transactions" CASCADE');
    await queryRunner.query('DROP TABLE IF EXISTS "credit_licenses" CASCADE');
    await queryRunner.query('DROP TYPE IF EXISTS "credit_purchase_status"');
    await queryRunner.query('DROP TYPE IF EXISTS "credit_transaction_type"');
  }

  public async down(): Promise<void> {
    // No-op: credit system is removed permanently.
  }
}
