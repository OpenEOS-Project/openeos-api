import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Druckauftraege:
 *
 * - `retry_count`: manuelle Wiederholungen (`POST …/print-jobs/:id/retry`).
 *   Bisher zaehlte `attempts` genau diese; jetzt meldet der Drucker-Agent
 *   dort seine echten Druckversuche. Die Grenze fuer manuelle
 *   Wiederholungen bekommt deshalb eine eigene Spalte, uebernommen aus dem
 *   bisherigen `attempts`.
 * - Teilindex auf offene Auftraege (`queued`/`printing`): die
 *   Nachlieferung (alle 30 s) und der Druck-Zustand fragen nur diese ab.
 */
export class PrintJobRetryCountAndOpenIndex1844400000000 implements MigrationInterface {
  name = 'PrintJobRetryCountAndOpenIndex1844400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "print_jobs" ADD COLUMN IF NOT EXISTS "retry_count" int NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `UPDATE "print_jobs" SET "retry_count" = "attempts" WHERE "attempts" > 0`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_print_jobs_open"
         ON "print_jobs" ("printer_id", "created_at")
         WHERE "status" IN ('queued', 'printing')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_print_jobs_open"`);
    await queryRunner.query(
      `ALTER TABLE "print_jobs" DROP COLUMN IF EXISTS "retry_count"`,
    );
  }
}
