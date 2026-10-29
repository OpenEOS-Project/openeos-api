import { QueryRunner } from 'typeorm';
import { CreateMenuImportsAndAiUsage1828000000000 } from './migrations/1828000000000-CreateMenuImportsAndAiUsage';

function fakeQueryRunner() {
  const statements: string[] = [];
  const commitTransaction = jest.fn(() => Promise.resolve());
  const startTransaction = jest.fn(() => Promise.resolve());
  const queryRunner = {
    query: jest.fn((sql: string) => {
      statements.push(sql.replace(/\s+/g, ' ').trim());
      return Promise.resolve([]);
    }),
    commitTransaction,
    startTransaction,
  } as unknown as QueryRunner;
  return { queryRunner, statements, commitTransaction, startTransaction };
}

describe('CreateMenuImportsAndAiUsage1828000000000', () => {
  const migration = new CreateMenuImportsAndAiUsage1828000000000();

  it('only expands: new tables, indexes and enum values, all idempotent', async () => {
    const { queryRunner, statements, commitTransaction, startTransaction } =
      fakeQueryRunner();
    await migration.up(queryRunner);

    expect(
      statements.filter((sql) =>
        sql.startsWith('ALTER TYPE "admin_action" ADD VALUE IF NOT EXISTS'),
      ),
    ).toHaveLength(3);
    expect(
      statements.some((sql) =>
        sql.startsWith('CREATE TABLE IF NOT EXISTS "menu_imports"'),
      ),
    ).toBe(true);
    expect(
      statements.some((sql) =>
        sql.startsWith('CREATE TABLE IF NOT EXISTS "ai_usage"'),
      ),
    ).toBe(true);
    expect(
      statements.filter((sql) => sql.startsWith('CREATE INDEX IF NOT EXISTS')),
    ).toHaveLength(3);
    expect(statements.some((sql) => /DROP|ALTER TABLE .* DROP/.test(sql))).toBe(
      false,
    );
    // enum values are added outside the transaction
    expect(commitTransaction).toHaveBeenCalledTimes(1);
    expect(startTransaction).toHaveBeenCalledTimes(1);
  });

  it('down() drops the tables and the audit entries of the new actions', async () => {
    const { queryRunner, statements } = fakeQueryRunner();
    await migration.down(queryRunner);
    expect(statements[0]).toBe('DROP TABLE IF EXISTS "ai_usage"');
    expect(statements[1]).toBe('DROP TABLE IF EXISTS "menu_imports"');
    expect(statements[2]).toMatch(/^DELETE FROM admin_audit_logs/);
  });
});
