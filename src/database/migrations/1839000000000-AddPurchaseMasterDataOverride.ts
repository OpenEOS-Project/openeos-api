import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Pflichtangaben beim Kauf (Entscheidung 2026-11-04): Erlaesst der Support
 * eine Veranstaltung ohne vollstaendige Angaben, steht das mit Grund im
 * Protokoll (`event_master_data_override`). Sonst keine Schemaaenderung —
 * die Angaben liegen in `organizations.settings` und `billing_address`.
 */
export class AddPurchaseMasterDataOverride1839000000000 implements MigrationInterface {
  name = 'AddPurchaseMasterDataOverride1839000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.commitTransaction();
    await queryRunner.query(
      `ALTER TYPE "admin_action" ADD VALUE IF NOT EXISTS 'event_master_data_override'`,
    );
    await queryRunner.startTransaction();
  }

  public async down(): Promise<void> {
    // Enum-Werte lassen sich in Postgres nicht entfernen.
  }
}
