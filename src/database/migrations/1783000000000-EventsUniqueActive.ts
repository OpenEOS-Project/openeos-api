import { MigrationInterface, QueryRunner } from 'typeorm';

export class EventsUniqueActive1783000000000 implements MigrationInterface {
  name = 'EventsUniqueActive1783000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Collapse any existing duplicates so the partial unique index can be created.
    // Per organization, keep the most recently created active|test event and demote the rest.
    await queryRunner.query(`
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY organization_id
                 ORDER BY (status = 'active') DESC, created_at DESC, id ASC
               ) AS rn
        FROM events
        WHERE status IN ('active', 'test')
      )
      UPDATE events
      SET status = 'inactive'
      WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "events_one_active_per_org"
      ON events (organization_id)
      WHERE status IN ('active', 'test')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "events_one_active_per_org"`);
  }
}
