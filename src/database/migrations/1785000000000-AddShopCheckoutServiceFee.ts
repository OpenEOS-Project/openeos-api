import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddShopCheckoutServiceFee1785000000000 implements MigrationInterface {
  name = 'AddShopCheckoutServiceFee1785000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "shop_checkouts"
      ADD COLUMN IF NOT EXISTS "service_fee" numeric(12, 2) NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "shop_checkouts"
      DROP COLUMN IF EXISTS "service_fee"
    `);
  }
}
