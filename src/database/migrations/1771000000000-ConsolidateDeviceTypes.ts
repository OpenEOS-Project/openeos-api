import { MigrationInterface, QueryRunner } from 'typeorm';

export class ConsolidateDeviceTypes1771000000000 implements MigrationInterface {
  name = 'ConsolidateDeviceTypes1771000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Step 0: Add suggested_name column if it doesn't exist
    const hasColumn = await queryRunner.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'devices' AND column_name = 'suggested_name'`,
    );
    if (hasColumn.length === 0) {
      await queryRunner.query(
        `ALTER TABLE devices ADD COLUMN "suggested_name" varchar(255)`,
      );
    }

    // Step 1: Convert column to varchar FIRST so parameterized queries work with old enum values
    await queryRunner.query(`ALTER TABLE devices ALTER COLUMN type TYPE varchar USING type::varchar`);

    // Step 2: Set displayMode in settings for each old display type
    const displayMappings = [
      { oldType: 'display_kitchen', mode: 'kitchen' },
      { oldType: 'display_delivery', mode: 'delivery' },
      { oldType: 'display_menu', mode: 'menu' },
      { oldType: 'display_pickup', mode: 'pickup' },
      { oldType: 'display_sales', mode: 'sales' },
      { oldType: 'display_customer', mode: 'customer' },
    ];

    for (const { oldType, mode } of displayMappings) {
      await queryRunner.query(
        `UPDATE devices SET settings = jsonb_set(settings, '{displayMode}', $1) WHERE type = $2`,
        [JSON.stringify(mode), oldType],
      );
    }

    // Step 3: Update all display_* types to 'display'
    await queryRunner.query(`UPDATE devices SET type = 'display' WHERE type LIKE 'display_%'`);

    // Step 4: Replace the PostgreSQL enum
    await queryRunner.query(`DROP TYPE IF EXISTS "device_type"`);
    await queryRunner.query(`CREATE TYPE "device_type" AS ENUM ('pos', 'display', 'admin')`);
    await queryRunner.query(`ALTER TABLE devices ALTER COLUMN type TYPE "device_type" USING type::"device_type"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Step 1: Convert column to varchar
    await queryRunner.query(`ALTER TABLE devices ALTER COLUMN type TYPE varchar USING type::varchar`);

    // Step 2: Restore old display_* types from displayMode in settings
    const displayModes = ['kitchen', 'delivery', 'menu', 'pickup', 'sales', 'customer'];

    for (const mode of displayModes) {
      await queryRunner.query(
        `UPDATE devices SET type = $1 WHERE type = 'display' AND settings->>'displayMode' = $2`,
        [`display_${mode}`, mode],
      );
    }

    // Fallback: any remaining 'display' without displayMode -> display_menu
    await queryRunner.query(`UPDATE devices SET type = 'display_menu' WHERE type = 'display'`);

    // Step 3: Recreate old enum and convert column back
    await queryRunner.query(`DROP TYPE IF EXISTS "device_type"`);
    await queryRunner.query(
      `CREATE TYPE "device_type" AS ENUM ('pos', 'display_kitchen', 'display_delivery', 'display_menu', 'display_pickup', 'display_sales', 'display_customer', 'admin')`,
    );
    await queryRunner.query(`ALTER TABLE devices ALTER COLUMN type TYPE "device_type" USING type::"device_type"`);

    // Step 4: Remove displayMode from settings
    await queryRunner.query(`UPDATE devices SET settings = settings - 'displayMode' WHERE settings ? 'displayMode'`);

    // Note: suggested_name column is NOT removed on down since it belongs to the device entity
  }
}
