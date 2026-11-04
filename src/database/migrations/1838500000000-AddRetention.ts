import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Aufbewahrung und Loeschung (README „Aufbewahrung und Löschung“):
 *
 * - `retention_runs`: Protokoll jedes Loeschlaufs (Datenart, Anzahl,
 *   Beginn/Ende, Probelauf, Fehler) und jeder Einzelloeschung auf Weisung.
 * - `retention_notices`: Ankuendigungen vor dem Schliessen bzw. endgueltigen
 *   Loeschen von Organisationen und Benutzerkonten. Je Gegenstand und Art
 *   hoechstens eine offene Ankuendigung.
 *
 * Nur neue Tabellen, keine Aenderung an bestehenden.
 */
export class AddRetention1838500000000 implements MigrationInterface {
  name = 'AddRetention1838500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS retention_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        category varchar(40) NOT NULL,
        trigger varchar(20) NOT NULL,
        dry_run boolean NOT NULL,
        status varchar(20) NOT NULL,
        started_at timestamp with time zone NOT NULL,
        finished_at timestamp with time zone NULL,
        counts jsonb NOT NULL DEFAULT '{}'::jsonb,
        total int NOT NULL DEFAULT 0,
        error text NULL,
        organization_id uuid NULL,
        executed_by_user_id uuid NULL,
        reason varchar(500) NULL,
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_retention_runs_trigger"
          CHECK (trigger IN ('scheduled', 'manual', 'instruction')),
        CONSTRAINT "CHK_retention_runs_status"
          CHECK (status IN ('running', 'succeeded', 'failed'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_retention_runs_category_started"
         ON retention_runs (category, started_at)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_retention_runs_started"
         ON retention_runs (started_at)`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS retention_notices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        subject_type varchar(20) NOT NULL,
        subject_id uuid NOT NULL,
        kind varchar(40) NOT NULL,
        sent_at timestamp with time zone NOT NULL,
        recipient_count int NOT NULL DEFAULT 0,
        due_at timestamp with time zone NOT NULL,
        activity_at timestamp with time zone NULL,
        executed_at timestamp with time zone NULL,
        cancelled_at timestamp with time zone NULL,
        cancel_reason varchar(40) NULL,
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_retention_notices_subject"
          CHECK (subject_type IN ('organization', 'user'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_retention_notices_subject"
         ON retention_notices (subject_type, subject_id)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_retention_notices_open"
         ON retention_notices (subject_type, subject_id, kind)
         WHERE executed_at IS NULL AND cancelled_at IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS retention_notices`);
    await queryRunner.query(`DROP TABLE IF EXISTS retention_runs`);
  }
}
