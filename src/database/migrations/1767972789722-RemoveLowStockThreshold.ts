import { MigrationInterface, QueryRunner } from "typeorm";

export class RemoveLowStockThreshold1767972789722 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "products"
            DROP COLUMN IF EXISTS "low_stock_threshold"
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "products"
            ADD COLUMN "low_stock_threshold" int NULL
        `);
    }

}
