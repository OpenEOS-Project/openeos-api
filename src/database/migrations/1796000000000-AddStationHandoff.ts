import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the handoff chain to production stations: handoff_station_id points
 * to the next station an order item moves to (e.g. Küche -> Ausgabe).
 */
export class AddStationHandoff1796000000000 implements MigrationInterface {
  name = 'AddStationHandoff1796000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE production_stations
      ADD COLUMN IF NOT EXISTS handoff_station_id uuid NULL
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_production_stations_handoff_station'
        ) THEN
          ALTER TABLE production_stations
          ADD CONSTRAINT fk_production_stations_handoff_station
          FOREIGN KEY (handoff_station_id) REFERENCES production_stations(id)
          ON DELETE SET NULL;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE production_stations
      DROP CONSTRAINT IF EXISTS fk_production_stations_handoff_station
    `);
    await queryRunner.query(`
      ALTER TABLE production_stations
      DROP COLUMN IF EXISTS handoff_station_id
    `);
  }
}
