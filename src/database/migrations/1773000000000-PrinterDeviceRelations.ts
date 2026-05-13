import { MigrationInterface, QueryRunner } from 'typeorm';

export class PrinterDeviceRelations1773000000000 implements MigrationInterface {
  name = 'PrinterDeviceRelations1773000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Step 1: Add 'printer_agent' to device_type enum
    // ALTER TYPE ADD VALUE cannot run inside a transaction in PostgreSQL
    await queryRunner.commitTransaction();
    await queryRunner.query(`
      ALTER TYPE "device_type" ADD VALUE IF NOT EXISTS 'printer_agent';
    `);
    await queryRunner.startTransaction();

    // Step 2: Printer entity - add device_id FK (replaces agent_id)
    await queryRunner.query(`
      ALTER TABLE printers ADD COLUMN IF NOT EXISTS "device_id" UUID REFERENCES devices(id) ON DELETE SET NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_printers_device_id" ON printers("device_id");
    `);

    // Step 3: Printer entity - add paper_width column
    await queryRunner.query(`
      ALTER TABLE printers ADD COLUMN IF NOT EXISTS "paper_width" INT NOT NULL DEFAULT 80;
    `);

    // Step 4: Printer entity - add rental_assignment_id column
    await queryRunner.query(`
      ALTER TABLE printers ADD COLUMN IF NOT EXISTS "rental_assignment_id" UUID;
    `);

    // Step 5: Drop agent_id column from printers
    await queryRunner.query(`
      ALTER TABLE printers DROP COLUMN IF EXISTS "agent_id";
    `);

    // Step 6: RentalHardware - add device_id FK
    await queryRunner.query(`
      ALTER TABLE rental_hardware ADD COLUMN IF NOT EXISTS "device_id" UUID REFERENCES devices(id) ON DELETE SET NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_rental_hardware_device_id" ON rental_hardware("device_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove rental_hardware device_id
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_rental_hardware_device_id"`);
    await queryRunner.query(`ALTER TABLE rental_hardware DROP COLUMN IF EXISTS "device_id"`);

    // Restore agent_id on printers
    await queryRunner.query(`ALTER TABLE printers ADD COLUMN "agent_id" VARCHAR(255)`);

    // Remove rental_assignment_id from printers
    await queryRunner.query(`ALTER TABLE printers DROP COLUMN IF EXISTS "rental_assignment_id"`);

    // Remove paper_width from printers
    await queryRunner.query(`ALTER TABLE printers DROP COLUMN IF EXISTS "paper_width"`);

    // Remove device_id from printers
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_printers_device_id"`);
    await queryRunner.query(`ALTER TABLE printers DROP COLUMN IF EXISTS "device_id"`);

    // Note: Cannot remove enum value 'printer_agent' from device_type in PostgreSQL
    // Would need to recreate the type entirely
  }
}
