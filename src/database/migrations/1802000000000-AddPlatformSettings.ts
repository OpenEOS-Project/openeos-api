import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Generic key/value store for platform-wide (super-admin) settings, starting
 * with the configurable admin-notification preferences (`adminNotifications`).
 */
export class AddPlatformSettings1802000000000 implements MigrationInterface {
  name = 'AddPlatformSettings1802000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        key varchar(100) PRIMARY KEY,
        value jsonb NOT NULL DEFAULT '{}',
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS platform_settings`);
  }
}
