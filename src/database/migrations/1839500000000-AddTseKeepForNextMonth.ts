import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cloud-TSE Lebenszyklus `monthly`, Folgemonat (Entscheidung 2026-11-06,
 * tse-swissbit-plan.md §8.3): hat der Verein im Folgemonat schon eine
 * bezahlte Veranstaltung, bleibt die TSE zum Monatsende aktiv. Die
 * Entscheidung steht in `tse_units.metadata.keeps` (jsonb, keine neue
 * Spalte); hier nur die Protokoll-Aktionen.
 */
export class AddTseKeepForNextMonth1839500000000 implements MigrationInterface {
  name = 'AddTseKeepForNextMonth1839500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enum-Werte lassen sich nicht in derselben Transaktion verwenden, in
    // der sie entstehen — wie in AddCloudTse.
    await queryRunner.commitTransaction();
    for (const value of ['tse_kept_for_next_month', 'tse_keep_revoked']) {
      await queryRunner.query(
        `ALTER TYPE "admin_action" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
    await queryRunner.startTransaction();
  }

  public async down(): Promise<void> {
    // Enum-Werte bleiben (Postgres kann sie nicht entfernen).
  }
}
