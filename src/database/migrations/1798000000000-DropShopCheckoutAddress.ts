import { MigrationInterface, QueryRunner } from 'typeorm';

/** Billing address was removed from the shop checkout — never used anywhere. */
export class DropShopCheckoutAddress1798000000000 implements MigrationInterface {
  name = 'DropShopCheckoutAddress1798000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE shop_checkouts DROP COLUMN IF EXISTS address
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE shop_checkouts ADD COLUMN IF NOT EXISTS address jsonb NULL
    `);
  }
}
