import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddShopCheckoutFulfillment1786000000000 implements MigrationInterface {
  name = 'AddShopCheckoutFulfillment1786000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'shop_checkout_fulfillment') THEN
          CREATE TYPE "shop_checkout_fulfillment" AS ENUM ('counter_pickup', 'table_service');
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "shop_checkouts"
      ADD COLUMN IF NOT EXISTS "fulfillment_type" "shop_checkout_fulfillment" NOT NULL DEFAULT 'counter_pickup'
    `);

    await queryRunner.query(`
      ALTER TABLE "shop_checkouts"
      ADD COLUMN IF NOT EXISTS "table_number" varchar(50)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "shop_checkouts" DROP COLUMN IF EXISTS "table_number"`);
    await queryRunner.query(`ALTER TABLE "shop_checkouts" DROP COLUMN IF EXISTS "fulfillment_type"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "shop_checkout_fulfillment"`);
  }
}
