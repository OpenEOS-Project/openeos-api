import { MigrationInterface, QueryRunner } from "typeorm";

export class RemoveUnusedProductFields1767973352270 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "products"
            DROP COLUMN IF EXISTS "cost_price",
            DROP COLUMN IF EXISTS "tax_rate",
            DROP COLUMN IF EXISTS "sku",
            DROP COLUMN IF EXISTS "barcode"
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "products"
            ADD COLUMN "cost_price" decimal(10,2) NULL,
            ADD COLUMN "tax_rate" decimal(5,2) DEFAULT 19.0,
            ADD COLUMN "sku" varchar(50) NULL,
            ADD COLUMN "barcode" varchar(50) NULL
        `);
    }

}
