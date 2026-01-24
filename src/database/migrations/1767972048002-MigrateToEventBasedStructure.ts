import { MigrationInterface, QueryRunner } from "typeorm";

export class MigrateToEventBasedStructure1767972048002 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        // ============================================
        // STEP 1: Delete orphaned data first (products depend on categories)
        // ============================================

        // Add event_id columns first to all tables
        await queryRunner.query(`
            ALTER TABLE "products"
            ADD COLUMN IF NOT EXISTS "event_id" uuid NULL
        `);
        await queryRunner.query(`
            ALTER TABLE "categories"
            ADD COLUMN IF NOT EXISTS "event_id" uuid NULL
        `);
        await queryRunner.query(`
            ALTER TABLE "stock_movements"
            ADD COLUMN IF NOT EXISTS "event_id" uuid NULL
        `);
        await queryRunner.query(`
            ALTER TABLE "inventory_counts"
            ADD COLUMN IF NOT EXISTS "event_id" uuid NULL
        `);

        // Delete products without event_id first (they reference categories)
        await queryRunner.query(`
            DELETE FROM "products" WHERE "event_id" IS NULL
        `);

        // Delete categories without event_id
        await queryRunner.query(`
            DELETE FROM "categories" WHERE "event_id" IS NULL
        `);

        // Delete stock_movements without event_id
        await queryRunner.query(`
            DELETE FROM "stock_movements" WHERE "event_id" IS NULL
        `);

        // Delete inventory_counts without event_id
        await queryRunner.query(`
            DELETE FROM "inventory_counts" WHERE "event_id" IS NULL
        `);

        // ============================================
        // CATEGORIES: organization_id -> event_id
        // ============================================

        // Drop existing foreign key and index for organization_id
        await queryRunner.query(`
            ALTER TABLE "categories"
            DROP CONSTRAINT IF EXISTS "FK_categories_organization"
        `);
        await queryRunner.query(`
            DROP INDEX IF EXISTS "IDX_categories_organization_id"
        `);
        await queryRunner.query(`
            DROP INDEX IF EXISTS "IDX_categories_organization_sort"
        `);
        await queryRunner.query(`
            DROP INDEX IF EXISTS "IDX_categories_organization_active"
        `);

        // Make event_id NOT NULL (data already cleaned)
        await queryRunner.query(`
            ALTER TABLE "categories"
            ALTER COLUMN "event_id" SET NOT NULL
        `);

        // Drop organization_id column
        await queryRunner.query(`
            ALTER TABLE "categories"
            DROP COLUMN IF EXISTS "organization_id"
        `);

        // Add foreign key and indexes for event_id
        await queryRunner.query(`
            ALTER TABLE "categories"
            ADD CONSTRAINT "FK_categories_event"
            FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_categories_event_sort" ON "categories" ("event_id", "sort_order")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_categories_event_active" ON "categories" ("event_id", "is_active")
        `);

        // ============================================
        // PRODUCTS: organization_id -> event_id
        // ============================================

        // Drop existing foreign key and index for organization_id
        await queryRunner.query(`
            ALTER TABLE "products"
            DROP CONSTRAINT IF EXISTS "FK_products_organization"
        `);
        await queryRunner.query(`
            DROP INDEX IF EXISTS "IDX_products_organization_id"
        `);
        await queryRunner.query(`
            DROP INDEX IF EXISTS "IDX_products_organization_category"
        `);
        await queryRunner.query(`
            DROP INDEX IF EXISTS "IDX_products_organization_active"
        `);

        // Make event_id NOT NULL (data already cleaned)
        await queryRunner.query(`
            ALTER TABLE "products"
            ALTER COLUMN "event_id" SET NOT NULL
        `);

        // Drop organization_id column
        await queryRunner.query(`
            ALTER TABLE "products"
            DROP COLUMN IF EXISTS "organization_id"
        `);

        // Add foreign key and indexes for event_id
        await queryRunner.query(`
            ALTER TABLE "products"
            ADD CONSTRAINT "FK_products_event"
            FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_products_event_category" ON "products" ("event_id", "category_id")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_products_event_active" ON "products" ("event_id", "is_active")
        `);

        // ============================================
        // STOCK_MOVEMENTS: organization_id -> event_id
        // ============================================

        // Drop existing foreign key and index for organization_id
        await queryRunner.query(`
            ALTER TABLE "stock_movements"
            DROP CONSTRAINT IF EXISTS "FK_stock_movements_organization"
        `);
        await queryRunner.query(`
            DROP INDEX IF EXISTS "IDX_stock_movements_organization_id"
        `);
        await queryRunner.query(`
            DROP INDEX IF EXISTS "IDX_stock_movements_organization_created"
        `);

        // Make event_id NOT NULL (data already cleaned, column already added)
        await queryRunner.query(`
            ALTER TABLE "stock_movements"
            ALTER COLUMN "event_id" SET NOT NULL
        `);

        // Drop organization_id column
        await queryRunner.query(`
            ALTER TABLE "stock_movements"
            DROP COLUMN IF EXISTS "organization_id"
        `);

        // Add foreign key and indexes for event_id
        await queryRunner.query(`
            ALTER TABLE "stock_movements"
            ADD CONSTRAINT "FK_stock_movements_event"
            FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_stock_movements_event_created" ON "stock_movements" ("event_id", "created_at")
        `);

        // ============================================
        // INVENTORY_COUNTS: organization_id -> event_id
        // ============================================

        // Drop existing foreign key and index for organization_id
        await queryRunner.query(`
            ALTER TABLE "inventory_counts"
            DROP CONSTRAINT IF EXISTS "FK_inventory_counts_organization"
        `);
        await queryRunner.query(`
            DROP INDEX IF EXISTS "IDX_inventory_counts_organization_id"
        `);

        // Make event_id NOT NULL (data already cleaned, column already added)
        await queryRunner.query(`
            ALTER TABLE "inventory_counts"
            ALTER COLUMN "event_id" SET NOT NULL
        `);

        // Drop organization_id column
        await queryRunner.query(`
            ALTER TABLE "inventory_counts"
            DROP COLUMN IF EXISTS "organization_id"
        `);

        // Add foreign key and indexes for event_id
        await queryRunner.query(`
            ALTER TABLE "inventory_counts"
            ADD CONSTRAINT "FK_inventory_counts_event"
            FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_inventory_counts_event" ON "inventory_counts" ("event_id")
        `);

        // Add 'initial' to stock_movement_type enum if not exists
        await queryRunner.query(`
            ALTER TYPE "stock_movement_type" ADD VALUE IF NOT EXISTS 'initial'
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Note: This down migration will lose data as we can't automatically
        // determine which organization the event belonged to

        // INVENTORY_COUNTS
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_inventory_counts_event"`);
        await queryRunner.query(`ALTER TABLE "inventory_counts" DROP CONSTRAINT IF EXISTS "FK_inventory_counts_event"`);
        await queryRunner.query(`ALTER TABLE "inventory_counts" DROP COLUMN IF EXISTS "event_id"`);
        await queryRunner.query(`ALTER TABLE "inventory_counts" ADD COLUMN "organization_id" uuid`);

        // STOCK_MOVEMENTS
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_stock_movements_event_created"`);
        await queryRunner.query(`ALTER TABLE "stock_movements" DROP CONSTRAINT IF EXISTS "FK_stock_movements_event"`);
        await queryRunner.query(`ALTER TABLE "stock_movements" DROP COLUMN IF EXISTS "event_id"`);
        await queryRunner.query(`ALTER TABLE "stock_movements" ADD COLUMN "organization_id" uuid`);

        // PRODUCTS
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_products_event_active"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_products_event_category"`);
        await queryRunner.query(`ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "FK_products_event"`);
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN IF EXISTS "event_id"`);
        await queryRunner.query(`ALTER TABLE "products" ADD COLUMN "organization_id" uuid`);

        // CATEGORIES
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_categories_event_active"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_categories_event_sort"`);
        await queryRunner.query(`ALTER TABLE "categories" DROP CONSTRAINT IF EXISTS "FK_categories_event"`);
        await queryRunner.query(`ALTER TABLE "categories" DROP COLUMN IF EXISTS "event_id"`);
        await queryRunner.query(`ALTER TABLE "categories" ADD COLUMN "organization_id" uuid`);
    }

}
