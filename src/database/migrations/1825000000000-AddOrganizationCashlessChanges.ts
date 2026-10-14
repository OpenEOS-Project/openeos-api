import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Protokoll des bargeldlosen Modus: jede Umschaltung mit Zeitpunkt und
 * handelnder Person (Nachweis, ab wann die Kassen kein Bargeld annehmen).
 * Der Schalter selbst liegt in `organizations.settings.payments`.
 */
export class AddOrganizationCashlessChanges1825000000000 implements MigrationInterface {
  name = 'AddOrganizationCashlessChanges1825000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS organization_cashless_changes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        organization_id uuid NOT NULL
          REFERENCES organizations(id) ON DELETE CASCADE,
        cashless boolean NOT NULL,
        changed_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        changed_by_name varchar(255) NULL,
        ip_address varchar(45) NULL,
        user_agent varchar(500) NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_org_cashless_changes_org_created"
         ON organization_cashless_changes (organization_id, created_at)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS organization_cashless_changes`,
    );
  }
}
