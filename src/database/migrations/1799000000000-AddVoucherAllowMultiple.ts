import { MigrationInterface, QueryRunner } from 'typeorm';

/** Lets a discount voucher be applied multiple times to one order. */
export class AddVoucherAllowMultiple1799000000000 implements MigrationInterface {
  name = 'AddVoucherAllowMultiple1799000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE discount_vouchers
      ADD COLUMN IF NOT EXISTS allow_multiple_per_order boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE discount_vouchers DROP COLUMN IF EXISTS allow_multiple_per_order
    `);
  }
}
