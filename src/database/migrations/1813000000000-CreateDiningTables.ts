import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tische und Bereiche auf Organisationsebene.
 *
 * - `table_areas`: Raum/Zone mit eigener Karte (Groesse in Einheiten,
 *   Raster, Deko-Elemente als jsonb).
 * - `dining_tables`: Tisch mit Bezeichnung, Form und Lage auf der Karte
 *   seines Bereichs. Die Bezeichnung ist je Organisation eindeutig
 *   (gross/klein egal, geloeschte zaehlen nicht).
 * - `orders.table_id` verweist best effort auf den Tisch; `table_number`
 *   bleibt der Anzeige-Snapshot und wird auf 50 Zeichen erweitert, weil
 *   der Shop bis zu 50 Zeichen annimmt.
 * - `orders.acknowledged_at`: wann die Kasse eine Gastbestellung gesehen hat.
 * - `products.is_favorite` / `products.icon` fuer die neue Kasse.
 *
 * Bestandsdaten werden nicht umgeschrieben: Orders ohne `table_id`
 * gruppieren weiter ueber `upper(trim(table_number))`.
 *
 * down() nimmt alles in umgekehrter Reihenfolge zurueck; `table_number`
 * wird dabei auf 20 Zeichen gekuerzt.
 */
export class CreateDiningTables1813000000000 implements MigrationInterface {
  name = 'CreateDiningTables1813000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE table_areas (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        updated_at timestamp with time zone NOT NULL DEFAULT now(),
        deleted_at timestamp with time zone NULL,
        organization_id uuid NOT NULL,
        name varchar(60) NOT NULL,
        sort_order int NOT NULL DEFAULT 0,
        width int NOT NULL DEFAULT 1200,
        height int NOT NULL DEFAULT 800,
        grid_size int NOT NULL DEFAULT 20,
        decor jsonb NOT NULL DEFAULT '[]'::jsonb,
        CONSTRAINT "FK_table_areas_organization" FOREIGN KEY (organization_id)
          REFERENCES organizations(id) ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_table_areas_org_name"
        ON table_areas (organization_id, lower(name))
        WHERE deleted_at IS NULL
    `);

    await queryRunner.query(
      `CREATE TYPE dining_table_shape AS ENUM ('rect', 'round')`,
    );
    await queryRunner.query(`
      CREATE TABLE dining_tables (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        updated_at timestamp with time zone NOT NULL DEFAULT now(),
        deleted_at timestamp with time zone NULL,
        organization_id uuid NOT NULL,
        area_id uuid NOT NULL,
        label varchar(20) NOT NULL,
        seats smallint NULL,
        shape dining_table_shape NOT NULL DEFAULT 'rect',
        x int NOT NULL DEFAULT 0,
        y int NOT NULL DEFAULT 0,
        width int NOT NULL DEFAULT 80,
        height int NOT NULL DEFAULT 80,
        rotation smallint NOT NULL DEFAULT 0,
        sort_order int NOT NULL DEFAULT 0,
        is_active boolean NOT NULL DEFAULT true,
        CONSTRAINT "FK_dining_tables_organization" FOREIGN KEY (organization_id)
          REFERENCES organizations(id) ON DELETE CASCADE,
        CONSTRAINT "FK_dining_tables_area" FOREIGN KEY (area_id)
          REFERENCES table_areas(id) ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_dining_tables_org_label"
        ON dining_tables (organization_id, upper(label))
        WHERE deleted_at IS NULL
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_dining_tables_area" ON dining_tables (area_id)`,
    );

    await queryRunner.query(`
      ALTER TABLE orders
        ADD COLUMN table_id uuid NULL,
        ADD COLUMN acknowledged_at timestamp with time zone NULL,
        ALTER COLUMN table_number TYPE varchar(50),
        ADD CONSTRAINT "FK_orders_table" FOREIGN KEY (table_id)
          REFERENCES dining_tables(id) ON DELETE SET NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_orders_event_table"
        ON orders (event_id, upper(table_number))
        WHERE table_number IS NOT NULL
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_table" ON orders (table_id) WHERE table_id IS NOT NULL`,
    );

    await queryRunner.query(`
      ALTER TABLE products
        ADD COLUMN is_favorite boolean NOT NULL DEFAULT false,
        ADD COLUMN icon varchar(50) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE products
        DROP COLUMN IF EXISTS icon,
        DROP COLUMN IF EXISTS is_favorite
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_orders_table"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_orders_event_table"`);
    await queryRunner.query(`
      ALTER TABLE orders
        DROP CONSTRAINT IF EXISTS "FK_orders_table",
        ALTER COLUMN table_number TYPE varchar(20) USING left(table_number, 20),
        DROP COLUMN IF EXISTS acknowledged_at,
        DROP COLUMN IF EXISTS table_id
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_dining_tables_area"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_dining_tables_org_label"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS dining_tables`);
    await queryRunner.query(`DROP TYPE IF EXISTS dining_table_shape`);

    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_table_areas_org_name"`);
    await queryRunner.query(`DROP TABLE IF EXISTS table_areas`);
  }
}
