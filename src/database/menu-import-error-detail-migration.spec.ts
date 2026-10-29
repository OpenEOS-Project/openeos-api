import { QueryRunner } from 'typeorm';
import { AddMenuImportErrorDetail1829000000000 } from './migrations/1829000000000-AddMenuImportErrorDetail';

function fakeQueryRunner() {
  const statements: string[] = [];
  const queryRunner = {
    query: jest.fn((sql: string) => {
      statements.push(sql.replace(/\s+/g, ' ').trim());
      return Promise.resolve([]);
    }),
  } as unknown as QueryRunner;
  return { queryRunner, statements };
}

describe('AddMenuImportErrorDetail1829000000000', () => {
  const migration = new AddMenuImportErrorDetail1829000000000();

  it('only adds the nullable column, idempotently', async () => {
    const { queryRunner, statements } = fakeQueryRunner();
    await migration.up(queryRunner);
    expect(statements).toEqual([
      'ALTER TABLE "menu_imports" ADD COLUMN IF NOT EXISTS "error_detail" text NULL',
    ]);
  });

  it('down() drops the column again', async () => {
    const { queryRunner, statements } = fakeQueryRunner();
    await migration.down(queryRunner);
    expect(statements).toEqual([
      'ALTER TABLE "menu_imports" DROP COLUMN IF EXISTS "error_detail"',
    ]);
  });
});
