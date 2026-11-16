import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Rechtspruefung 2026-11:
 *
 * - `content_reports`: Meldungen rechtswidriger Inhalte auf Shops und
 *   Helferseiten (Melde- und Abhilfeverfahren, Art. 16/17 DSA). Pruefung
 *   und Entscheidung durch den Super-Admin; geloescht 12 Monate nach dem
 *   Abschluss (Loeschlauf `content_reports`).
 */
export class AddContentReports1843500000000 implements MigrationInterface {
  name = 'AddContentReports1843500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS content_reports (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        updated_at timestamp with time zone NOT NULL DEFAULT now(),
        url varchar(1000) NOT NULL,
        reason varchar(40) NOT NULL,
        description text NOT NULL,
        reporter_name varchar(200) NOT NULL,
        reporter_email varchar(255) NOT NULL,
        good_faith boolean NOT NULL DEFAULT false,
        target_type varchar(20) NOT NULL DEFAULT 'unknown',
        organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
        event_id uuid REFERENCES events(id) ON DELETE SET NULL,
        shift_plan_id uuid REFERENCES shift_plans(id) ON DELETE SET NULL,
        status varchar(20) NOT NULL DEFAULT 'open',
        action varchar(20),
        decision text,
        facts text,
        ground text,
        redress text,
        action_applied_at timestamp with time zone,
        receipt_sent_at timestamp with time zone,
        admin_notified_at timestamp with time zone,
        reporter_notified_at timestamp with time zone,
        organization_notified_at timestamp with time zone,
        closed_at timestamp with time zone,
        handled_by uuid REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT chk_content_reports_status
          CHECK (status IN ('open', 'in_review', 'closed')),
        CONSTRAINT chk_content_reports_action
          CHECK (action IS NULL OR action IN ('none', 'hide_content', 'disable_shop'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_content_reports_status_created
        ON content_reports (status, created_at DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_content_reports_organization
        ON content_reports (organization_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS content_reports`);
  }
}
