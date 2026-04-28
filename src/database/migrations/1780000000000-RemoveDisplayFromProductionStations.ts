import { MigrationInterface, QueryRunner } from 'typeorm';

export class RemoveDisplayFromProductionStations1780000000000 implements MigrationInterface {
  name = 'RemoveDisplayFromProductionStations1780000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop foreign key constraints first
    await queryRunner.query(`ALTER TABLE "production_stations" DROP CONSTRAINT IF EXISTS "FK_production_stations_display_device"`);
    await queryRunner.query(`ALTER TABLE "production_stations" DROP CONSTRAINT IF EXISTS "FK_production_stations_handoff_station"`);

    // Drop columns
    await queryRunner.query(`ALTER TABLE "production_stations" DROP COLUMN IF EXISTS "display_device_id"`);
    await queryRunner.query(`ALTER TABLE "production_stations" DROP COLUMN IF EXISTS "handoff_station_id"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "production_stations"
        ADD COLUMN "handoff_station_id" uuid NULL,
        ADD COLUMN "display_device_id" uuid NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "production_stations"
        ADD CONSTRAINT "FK_production_stations_handoff_station"
        FOREIGN KEY ("handoff_station_id") REFERENCES "production_stations"("id") ON DELETE SET NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "production_stations"
        ADD CONSTRAINT "FK_production_stations_display_device"
        FOREIGN KEY ("display_device_id") REFERENCES "devices"("id") ON DELETE SET NULL
    `);
  }
}
