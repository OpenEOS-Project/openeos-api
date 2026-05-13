import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPrinterDisplayToProductionStations1775000000000 implements MigrationInterface {
  name = 'AddPrinterDisplayToProductionStations1775000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "production_stations"
        ADD COLUMN IF NOT EXISTS "printer_id" uuid NULL,
        ADD COLUMN IF NOT EXISTS "display_device_id" uuid NULL
    `);

    // Drop pre-existing FKs (e.g. from partial run) before re-adding by name.
    await queryRunner.query(`ALTER TABLE "production_stations" DROP CONSTRAINT IF EXISTS "FK_production_stations_printer"`);
    await queryRunner.query(`
      ALTER TABLE "production_stations"
        ADD CONSTRAINT "FK_production_stations_printer"
        FOREIGN KEY ("printer_id") REFERENCES "printers"("id") ON DELETE SET NULL
    `);

    await queryRunner.query(`ALTER TABLE "production_stations" DROP CONSTRAINT IF EXISTS "FK_production_stations_display_device"`);
    await queryRunner.query(`
      ALTER TABLE "production_stations"
        ADD CONSTRAINT "FK_production_stations_display_device"
        FOREIGN KEY ("display_device_id") REFERENCES "devices"("id") ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "production_stations" DROP CONSTRAINT IF EXISTS "FK_production_stations_display_device"`);
    await queryRunner.query(`ALTER TABLE "production_stations" DROP CONSTRAINT IF EXISTS "FK_production_stations_printer"`);
    await queryRunner.query(`ALTER TABLE "production_stations" DROP COLUMN IF EXISTS "display_device_id"`);
    await queryRunner.query(`ALTER TABLE "production_stations" DROP COLUMN IF EXISTS "printer_id"`);
  }
}
