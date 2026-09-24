import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tabelle fuer API-Tokens.
 *
 * Nur der Hash wird abgelegt; der Token selbst existiert nach der
 * Ausstellung nirgends mehr. Der Index auf den Hash ist eindeutig und
 * traegt zugleich die Suche bei jeder Anfrage.
 */
export class AddApiTokens1811000000000 implements MigrationInterface {
  name = 'AddApiTokens1811000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS api_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        updated_at timestamp with time zone NOT NULL DEFAULT now(),
        name varchar(100) NOT NULL,
        token_hash varchar(64) NOT NULL,
        token_prefix varchar(16) NOT NULL,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
        expires_at timestamp with time zone,
        last_used_at timestamp with time zone,
        revoked_at timestamp with time zone
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_token_hash ON api_tokens (token_hash)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS api_tokens`);
  }
}
