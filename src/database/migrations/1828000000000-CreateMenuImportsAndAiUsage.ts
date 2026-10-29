import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Assistent, Phase 1 (ki-plan.md Abschnitt 6):
 *
 * - `menu_imports`: Speisekarten-Importe je Veranstaltung mit Vorschlag,
 *   Dateipfaden und Status.
 * - `ai_usage`: ein Eintrag je Modellaufruf — Tageskontingente,
 *   Monitoring, spaeter Abrechnung.
 * - `admin_action`: Protokolleintraege fuers Ein-/Ausschalten und fuers
 *   Anwenden eines Imports.
 *
 * Nur Erweiterungen (expand) — laufende Instanzen der Vorversion kommen
 * damit zurecht. Enum-Werte lassen sich in PostgreSQL nicht entfernen,
 * down() laesst sie stehen.
 */
export class CreateMenuImportsAndAiUsage1828000000000 implements MigrationInterface {
  name = 'CreateMenuImportsAndAiUsage1828000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ALTER TYPE ADD VALUE cannot run inside a transaction in PostgreSQL
    await queryRunner.commitTransaction();
    for (const value of [
      'assistant_enabled',
      'assistant_disabled',
      'menu_import_applied',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "admin_action" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
    await queryRunner.startTransaction();

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "menu_imports" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at" timestamp with time zone NOT NULL DEFAULT now(),
        "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
        "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "event_id" uuid NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
        "user_id" uuid NULL REFERENCES "users"("id") ON DELETE SET NULL,
        "status" varchar(20) NOT NULL DEFAULT 'queued',
        "source" varchar(10) NOT NULL,
        "files" jsonb NOT NULL DEFAULT '[]',
        "input_text" text NULL,
        "suggestion" jsonb NULL,
        "error" text NULL,
        "usage" jsonb NULL,
        "finished_at" timestamp with time zone NULL,
        "applied_at" timestamp with time zone NULL,
        "usage_id" uuid NULL,
        "files_deleted_at" timestamp with time zone NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_menu_imports_event_created"
         ON "menu_imports" ("event_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_menu_imports_status_created"
         ON "menu_imports" ("status", "created_at")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ai_usage" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at" timestamp with time zone NOT NULL DEFAULT now(),
        "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "user_id" uuid NULL REFERENCES "users"("id") ON DELETE SET NULL,
        "feature" varchar(40) NOT NULL,
        "provider" varchar(20) NOT NULL,
        "model" varchar(100) NOT NULL,
        "units" integer NOT NULL DEFAULT 1,
        "input_tokens" integer NOT NULL DEFAULT 0,
        "output_tokens" integer NOT NULL DEFAULT 0,
        "duration_ms" integer NOT NULL DEFAULT 0,
        "status" varchar(20) NOT NULL DEFAULT 'reserved'
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ai_usage_org_feature_created"
         ON "ai_usage" ("organization_id", "feature", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_usage"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "menu_imports"`);
    await queryRunner.query(
      `DELETE FROM admin_audit_logs
        WHERE action::text IN ('assistant_enabled', 'assistant_disabled', 'menu_import_applied')`,
    );
  }
}
