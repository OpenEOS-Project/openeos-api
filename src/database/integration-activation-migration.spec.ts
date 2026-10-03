import { QueryRunner } from 'typeorm';
import { AddIntegrationActivation1812000000000 } from './migrations/1812000000000-AddIntegrationActivation';

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

describe('AddIntegrationActivation1812000000000', () => {
  const migration = new AddIntegrationActivation1812000000000();

  it('enables sumup only for organizations with a merchant code and no entry yet', async () => {
    const { queryRunner, statements } = fakeQueryRunner();

    await migration.up(queryRunner);

    expect(statements).toHaveLength(1);
    const [sql] = statements;
    expect(sql).toMatch(/^UPDATE organizations SET settings = jsonb_set\(/);
    expect(sql).toContain("'{integrations,sumup}'");
    expect(sql).toContain("jsonb_build_object( 'enabled', true, 'enabledAt',");
    // create_missing fuer beide Ebenen
    expect(sql.match(/, true \)/g)).toHaveLength(2);
    expect(sql).toContain(
      "WHERE COALESCE(settings->'sumup'->>'merchantCode', '') <> ''",
    );
    expect(sql).toContain("AND settings->'integrations'->'sumup' IS NULL");
    // Zugangsdaten werden nicht angefasst
    expect(sql).not.toMatch(/'\{sumup/);
  });

  it('removes the sumup entry and an empty integrations block on down()', async () => {
    const { queryRunner, statements } = fakeQueryRunner();

    await migration.down(queryRunner);

    expect(statements).toEqual([
      "UPDATE organizations SET settings = settings #- '{integrations,sumup}' WHERE settings->'integrations'->'sumup' IS NOT NULL",
      "UPDATE organizations SET settings = settings - 'integrations' WHERE settings->'integrations' = '{}'::jsonb",
    ]);
  });
});
