import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDiscountVouchers1794000000000 implements MigrationInterface {
  name = 'CreateDiscountVouchers1794000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "discount_voucher_type" AS ENUM ('fixed', 'manual');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "discount_vouchers" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" uuid NOT NULL,
        "name" character varying(255) NOT NULL,
        "description" character varying(500),
        "type" "discount_voucher_type" NOT NULL,
        "amount" numeric(10,2),
        "is_active" boolean NOT NULL DEFAULT true,
        "sort_order" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_discount_vouchers" PRIMARY KEY ("id"),
        CONSTRAINT "FK_discount_vouchers_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_discount_vouchers_organization_id" ON "discount_vouchers" ("organization_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "discount_vouchers"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "discount_voucher_type"`);
  }
}
