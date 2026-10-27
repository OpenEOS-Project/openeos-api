import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drucker-Umbau: der Drucker-Agent findet USB-/Netzwerk-/Windows-Drucker
 * selbst und meldet sie als `discovered_printers`; die Organisation
 * uebernimmt sie in der Web-App. Die Hardware-Vermietung entfaellt.
 *
 * Expand-Schritt (laeuft neben dem bisherigen Code):
 * - `discovered_printers` neu
 * - `printers.fingerprint` (eindeutig je Agent), `devices.agent_info`
 * - `printer_connection_type` um `windows` erweitert; vorhandene
 *   `bluetooth`-Zeilen (nie implementiert) werden auf `network` gesetzt
 * - Vermietungstabellen fallen weg (nur der entfernte Vermietungscode hat
 *   sie gelesen)
 *
 * Contract-Schritt (spaeteres Release, wenn kein alter Code mehr laeuft):
 * `printers.rental_assignment_id` und `printers.agent_local_id` entfernen,
 * `bluetooth` aus dem Enum nehmen. Siehe README „expand/contract“.
 */
export class PrinterAgentDiscovery1826000000000 implements MigrationInterface {
  name = 'PrinterAgentDiscovery1826000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ALTER TYPE ADD VALUE cannot run inside a transaction in PostgreSQL
    await queryRunner.commitTransaction();
    await queryRunner.query(
      `ALTER TYPE "printer_connection_type" ADD VALUE IF NOT EXISTS 'windows'`,
    );
    await queryRunner.startTransaction();

    await queryRunner.query(
      `UPDATE "printers" SET "connection_type" = 'network' WHERE "connection_type" = 'bluetooth'`,
    );

    await queryRunner.query(
      `ALTER TABLE "printers" ADD COLUMN IF NOT EXISTS "fingerprint" varchar(255)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_printers_device_fingerprint"
         ON "printers" ("device_id", "fingerprint")
         WHERE "fingerprint" IS NOT NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "agent_info" jsonb`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "discovered_printers" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at" timestamp with time zone NOT NULL DEFAULT now(),
        "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
        "device_id" uuid NOT NULL REFERENCES "devices"("id") ON DELETE CASCADE,
        "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "fingerprint" varchar(255) NOT NULL,
        "connection_type" "printer_connection_type" NOT NULL,
        "display_name" varchar(255) NOT NULL,
        "details" jsonb NOT NULL DEFAULT '{}',
        "discovered_via" varchar(20) NOT NULL,
        "first_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
        "last_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
        "printer_id" uuid NULL REFERENCES "printers"("id") ON DELETE SET NULL,
        CONSTRAINT "UQ_discovered_printers_device_fingerprint" UNIQUE ("device_id", "fingerprint")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_discovered_printers_organization" ON "discovered_printers" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_discovered_printers_printer" ON "discovered_printers" ("printer_id")`,
    );

    // Hardware-Vermietung: Tabellen samt Fremdschluesseln entfernen.
    await queryRunner.query(
      `DROP TABLE IF EXISTS "rental_assignments" CASCADE`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "rental_hardware" CASCADE`);
    await queryRunner.query(`DROP TYPE IF EXISTS "rental_assignment_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "rental_hardware_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "rental_hardware_type"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "discovered_printers"`);
    await queryRunner.query(
      `ALTER TABLE "devices" DROP COLUMN IF EXISTS "agent_info"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_printers_device_fingerprint"`,
    );
    await queryRunner.query(
      `ALTER TABLE "printers" DROP COLUMN IF EXISTS "fingerprint"`,
    );
    // Der Enum-Wert `windows` bleibt (Postgres kann Werte nicht entfernen);
    // die Vermietungstabellen werden nicht wiederhergestellt.
  }
}
