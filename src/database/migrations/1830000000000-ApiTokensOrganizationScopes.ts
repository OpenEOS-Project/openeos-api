import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * API-Tokens je Organisation (ki-plan.md Abschnitt 8).
 *
 * - `api_tokens.organization_id`: auf welche Organisation ein Token
 *   beschraenkt ist. NULL bleibt fuer die bestehenden Plattform-Tokens
 *   (Super-Admin, `monitoring:read`).
 * - `admin_action`: Protokolleintraege fuer Ausstellen und Widerrufen.
 *
 * Nur Erweiterungen (expand); Enum-Werte lassen sich in PostgreSQL nicht
 * entfernen, down() laesst sie stehen.
 */
export class ApiTokensOrganizationScopes1830000000000 implements MigrationInterface {
  name = 'ApiTokensOrganizationScopes1830000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ALTER TYPE ADD VALUE cannot run inside a transaction in PostgreSQL
    await queryRunner.commitTransaction();
    for (const value of ['api_token_created', 'api_token_revoked']) {
      await queryRunner.query(
        `ALTER TYPE "admin_action" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
    await queryRunner.startTransaction();

    await queryRunner.query(`
      ALTER TABLE "api_tokens"
        ADD COLUMN IF NOT EXISTS "organization_id" uuid NULL
          REFERENCES "organizations"("id") ON DELETE CASCADE
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_api_tokens_organization_id"
        ON "api_tokens" ("organization_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_api_tokens_organization_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "api_tokens" DROP COLUMN IF EXISTS "organization_id"`,
    );
  }
}
