import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrderFulfillmentType1777000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "order_fulfillment_type" AS ENUM('table_service', 'counter_pickup')`);
    await queryRunner.query(`ALTER TABLE "orders" ADD "fulfillment_type" "order_fulfillment_type" NOT NULL DEFAULT 'counter_pickup'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "fulfillment_type"`);
    await queryRunner.query(`DROP TYPE "order_fulfillment_type"`);
  }
}
