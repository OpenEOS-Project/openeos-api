import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePfandSystem1795000000000 implements MigrationInterface {
  name = 'CreatePfandSystem1795000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- pfand_types (reusable deposit types, org-scoped) ---
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "pfand_types" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" uuid NOT NULL,
        "name" character varying(255) NOT NULL,
        "amount" numeric(10,2) NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "sort_order" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_pfand_types" PRIMARY KEY ("id"),
        CONSTRAINT "FK_pfand_types_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_pfand_types_organization_id" ON "pfand_types" ("organization_id")`,
    );

    // --- pfand_returns (payout ledger) ---
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "pfand_returns" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" uuid NOT NULL,
        "event_id" uuid,
        "device_id" uuid,
        "created_by_user_id" uuid,
        "total_amount" numeric(10,2) NOT NULL,
        "lines" jsonb NOT NULL DEFAULT '[]',
        CONSTRAINT "PK_pfand_returns" PRIMARY KEY ("id"),
        CONSTRAINT "FK_pfand_returns_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_pfand_returns_organization_id" ON "pfand_returns" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_pfand_returns_event_id" ON "pfand_returns" ("event_id")`,
    );

    // --- products.pfand_type_id ---
    await queryRunner.query(
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "pfand_type_id" uuid`,
    );
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "products" ADD CONSTRAINT "FK_products_pfand_type"
          FOREIGN KEY ("pfand_type_id") REFERENCES "pfand_types"("id") ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN null;
      END $$;
    `);

    // --- order_items pfand columns ---
    await queryRunner.query(
      `ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "pfand_type_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "deposit_amount" numeric(10,2) NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "is_refill" boolean NOT NULL DEFAULT false`,
    );

    // --- orders.pfand_total ---
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "pfand_total" numeric(10,2) NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "pfand_total"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" DROP COLUMN IF EXISTS "is_refill"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" DROP COLUMN IF EXISTS "deposit_amount"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" DROP COLUMN IF EXISTS "pfand_type_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "FK_products_pfand_type"`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" DROP COLUMN IF EXISTS "pfand_type_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "pfand_returns"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "pfand_types"`);
  }
}
