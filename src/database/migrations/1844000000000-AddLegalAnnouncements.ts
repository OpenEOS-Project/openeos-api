import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ankuendigungen neuer Fassungen der Rechtstexte (`legal_announcements`),
 * die Mails dazu (`legal_announcement_deliveries`) und wer den Hinweis in
 * der App weggeklickt hat (`legal_announcement_dismissals`).
 */
export class AddLegalAnnouncements1844000000000 implements MigrationInterface {
  name = 'AddLegalAnnouncements1844000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS legal_announcements (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        documents varchar(10)[] NOT NULL
          CONSTRAINT "CHK_legal_announcements_documents" CHECK (
            cardinality(documents) > 0
            AND documents <@ ARRAY['agb', 'anlage1', 'avv', 'privacy', 'imprint']::varchar(10)[]
          ),
        version varchar(10) NOT NULL
          CONSTRAINT "CHK_legal_announcements_version" CHECK (version ~ '^\\d{4}-\\d{2}-\\d{2}$'),
        previous_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
        summary_de text NOT NULL,
        summary_en text NULL,
        short_notice boolean NOT NULL DEFAULT false,
        explicit_consent boolean NOT NULL DEFAULT false,
        created_by_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        created_by_email varchar(255) NOT NULL,
        created_at timestamp with time zone NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_legal_announcements_version" ON legal_announcements (version)`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS legal_announcement_deliveries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        announcement_id uuid NOT NULL REFERENCES legal_announcements(id) ON DELETE CASCADE,
        email varchar(255) NOT NULL,
        first_name varchar(100) NULL,
        status varchar(10) NOT NULL DEFAULT 'pending'
          CONSTRAINT "CHK_legal_announcement_deliveries_status" CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
        attempts int NOT NULL DEFAULT 0,
        error varchar(500) NULL,
        claimed_at timestamp with time zone NULL,
        sent_at timestamp with time zone NULL,
        created_at timestamp with time zone NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_legal_announcement_deliveries_email" ON legal_announcement_deliveries (announcement_id, lower(email))`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_legal_announcement_deliveries_announcement" ON legal_announcement_deliveries (announcement_id, status)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_legal_announcement_deliveries_open" ON legal_announcement_deliveries (created_at) WHERE status IN ('pending', 'sending')`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS legal_announcement_dismissals (
        announcement_id uuid NOT NULL REFERENCES legal_announcements(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        dismissed_at timestamp with time zone NOT NULL DEFAULT now(),
        PRIMARY KEY (announcement_id, user_id)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS legal_announcement_dismissals`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS legal_announcement_deliveries`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS legal_announcements`);
  }
}
