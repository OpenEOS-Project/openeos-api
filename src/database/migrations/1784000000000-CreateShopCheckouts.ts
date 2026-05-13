import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateShopCheckouts1784000000000 implements MigrationInterface {
  name = 'CreateShopCheckouts1784000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'shop_checkout_status') THEN
          CREATE TYPE "shop_checkout_status" AS ENUM ('pending', 'paid', 'failed', 'cancelled');
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "shop_checkouts" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMPTZ NULL,
        "organization_id" uuid NOT NULL,
        "event_id" uuid NOT NULL,
        "email" varchar(255) NOT NULL,
        "customer_name" jsonb,
        "address" jsonb,
        "items" jsonb NOT NULL,
        "total_amount" numeric(12, 2) NOT NULL,
        "currency" varchar(3) NOT NULL DEFAULT 'EUR',
        "sumup_checkout_id" varchar(255),
        "sumup_checkout_url" text,
        "status" "shop_checkout_status" NOT NULL DEFAULT 'pending',
        "order_id" uuid,
        "paid_at" TIMESTAMPTZ,
        CONSTRAINT "fk_shop_checkouts_organization"
          FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_shop_checkouts_event"
          FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_shop_checkouts_order"
          FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_shop_checkouts_org_status" ON "shop_checkouts" ("organization_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_shop_checkouts_event" ON "shop_checkouts" ("event_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_shop_checkouts_sumup" ON "shop_checkouts" ("sumup_checkout_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "shop_checkouts"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "shop_checkout_status"`);
  }
}
