import { MigrationInterface, QueryRunner } from 'typeorm';

export class AllowDeviceWithoutOrganization1769800000000 implements MigrationInterface {
  name = 'AllowDeviceWithoutOrganization1769800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Make organization_id nullable for unlinked devices
    await queryRunner.query(`
      ALTER TABLE devices
      ALTER COLUMN organization_id DROP NOT NULL
    `);

    // Add new device types for TV displays
    await queryRunner.query(`
      ALTER TYPE device_type ADD VALUE IF NOT EXISTS 'display_menu'
    `);
    await queryRunner.query(`
      ALTER TYPE device_type ADD VALUE IF NOT EXISTS 'display_pickup'
    `);
    await queryRunner.query(`
      ALTER TYPE device_type ADD VALUE IF NOT EXISTS 'display_sales'
    `);

    // Add device_name column for unlinked devices (optional friendly name)
    await queryRunner.query(`
      ALTER TABLE devices
      ADD COLUMN IF NOT EXISTS suggested_name VARCHAR(255) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove suggested_name column
    await queryRunner.query(`
      ALTER TABLE devices DROP COLUMN IF EXISTS suggested_name
    `);

    // Note: Cannot easily remove enum values in PostgreSQL
    // We'll leave the device types as they are

    // Make organization_id required again (only if no NULL values exist)
    await queryRunner.query(`
      DELETE FROM devices WHERE organization_id IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE devices
      ALTER COLUMN organization_id SET NOT NULL
    `);
  }
}
