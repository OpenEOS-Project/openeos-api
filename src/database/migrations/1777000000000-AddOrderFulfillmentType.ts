import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrderFulfillmentType1777000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_fulfillment_type') THEN
          CREATE TYPE "order_fulfillment_type" AS ENUM('table_service', 'counter_pickup');
        END IF;
      END $$;
    `);
    await queryRunner.query(`ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "fulfillment_type" "order_fulfillment_type" NOT NULL DEFAULT 'counter_pickup'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN IF EXISTS "fulfillment_type"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "order_fulfillment_type"`);
  }
}
