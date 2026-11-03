import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cloud-TSE Lebenszyklus `monthly` (Entscheidung 2026-11-04,
 * tse-swissbit-plan.md §8.3). Nur Erweiterungen:
 *
 * - `tse_units.planned_deactivation_at`: geplante Abmeldung (letzter Tag
 *   des Monats, 20:00 Berlin). Aktive TSEs ohne Termin bekommt der
 *   Monatslauf beim ersten Durchgang (Ende des laufenden Monats).
 * - `deactivation_attempts`, `deactivation_next_attempt_at`: Wiederholung
 *   mit Backoff, wenn Swissbit die Abmeldung ablehnt oder nicht antwortet.
 * - `deactivation_alerted_at`: Warnung an den Betreiber (22:00) gesendet.
 * - Protokoll: `tse_deactivation_postponed`, `tse_deactivation_overdue`.
 */
export class AddTseMonthlyLifecycle1838000000000 implements MigrationInterface {
  name = 'AddTseMonthlyLifecycle1838000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE tse_units ADD COLUMN IF NOT EXISTS planned_deactivation_at timestamptz NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE tse_units ADD COLUMN IF NOT EXISTS deactivation_attempts integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE tse_units ADD COLUMN IF NOT EXISTS deactivation_next_attempt_at timestamptz NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE tse_units ADD COLUMN IF NOT EXISTS deactivation_alerted_at timestamptz NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tse_units_planned_deactivation"
         ON tse_units (planned_deactivation_at) WHERE state = 'active'`,
    );

    // Enum-Werte lassen sich nicht in derselben Transaktion verwenden, in
    // der sie entstehen — wie in AddCloudTse.
    await queryRunner.commitTransaction();
    for (const value of [
      'tse_deactivation_postponed',
      'tse_deactivation_overdue',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "admin_action" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
    await queryRunner.startTransaction();
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Enum-Werte bleiben (Postgres kann sie nicht entfernen).
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_tse_units_planned_deactivation"`,
    );
    for (const column of [
      'deactivation_alerted_at',
      'deactivation_next_attempt_at',
      'deactivation_attempts',
      'planned_deactivation_at',
    ]) {
      await queryRunner.query(
        `ALTER TABLE tse_units DROP COLUMN IF EXISTS ${column}`,
      );
    }
  }
}
