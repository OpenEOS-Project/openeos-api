import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Anmeldung per E-Mail-Link.
 *
 * Nur der Hash wird gespeichert, deshalb `token_hash` und nicht `token`
 * wie beim aelteren Helfer-Link: dieser Token oeffnet ein Konto.
 *
 * Der Index auf `expires_at` traegt das Aufraeumen abgelaufener Zeilen,
 * das sonst ueber die ganze Tabelle laufen muesste.
 */
export class AddLoginMagicLinks1806000000000 implements MigrationInterface {
  name = 'AddLoginMagicLinks1806000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS login_magic_links (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        token_hash varchar(64) NOT NULL,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at timestamp with time zone NOT NULL,
        used_at timestamp with time zone,
        requested_ip varchar(45)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_login_magic_links_token_hash
      ON login_magic_links (token_hash)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_login_magic_links_user
      ON login_magic_links (user_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_login_magic_links_expires
      ON login_magic_links (expires_at)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS login_magic_links`);
  }
}
