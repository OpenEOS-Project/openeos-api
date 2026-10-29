import { QueryRunner } from 'typeorm';
import { ApiTokensOrganizationScopes1830000000000 } from './migrations/1830000000000-ApiTokensOrganizationScopes';

function fakeQueryRunner() {
  const statements: string[] = [];
  const queryRunner = {
    query: jest.fn((sql: string) => {
      statements.push(sql.replace(/\s+/g, ' ').trim());
      return Promise.resolve([]);
    }),
    commitTransaction: jest.fn(() => {
      statements.push('COMMIT');
      return Promise.resolve();
    }),
    startTransaction: jest.fn(() => {
      statements.push('BEGIN');
      return Promise.resolve();
    }),
  } as unknown as QueryRunner;
  return { queryRunner, statements };
}

describe('ApiTokensOrganizationScopes1830000000000', () => {
  const migration = new ApiTokensOrganizationScopes1830000000000();

  it('adds the enum values outside the transaction, then the nullable column', async () => {
    const { queryRunner, statements } = fakeQueryRunner();
    await migration.up(queryRunner);
    expect(statements).toEqual([
      'COMMIT',
      `ALTER TYPE "admin_action" ADD VALUE IF NOT EXISTS 'api_token_created'`,
      `ALTER TYPE "admin_action" ADD VALUE IF NOT EXISTS 'api_token_revoked'`,
      'BEGIN',
      'ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "organization_id" uuid NULL REFERENCES "organizations"("id") ON DELETE CASCADE',
      'CREATE INDEX IF NOT EXISTS "IDX_api_tokens_organization_id" ON "api_tokens" ("organization_id")',
    ]);
  });

  it('down() removes index and column, keeps the enum values', async () => {
    const { queryRunner, statements } = fakeQueryRunner();
    await migration.down(queryRunner);
    expect(statements).toEqual([
      'DROP INDEX IF EXISTS "IDX_api_tokens_organization_id"',
      'ALTER TABLE "api_tokens" DROP COLUMN IF EXISTS "organization_id"',
    ]);
  });
});
