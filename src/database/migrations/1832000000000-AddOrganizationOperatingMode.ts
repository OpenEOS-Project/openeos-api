import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Betriebsmodus „Nur Bestellen“: Verlauf jeder Umschaltung (Zeitpunkt,
 * Support-Mitarbeiter, Grund, alter → neuer Modus) und ein eigener Wert im
 * Admin-Protokoll. Der Modus selbst liegt in
 * `organizations.settings.operatingMode` (fehlt = `pos`), deshalb keine
 * Datenaenderung an bestehenden Organisationen.
 *
 * Nur Erweiterung (expand); Enum-Werte lassen sich in PostgreSQL nicht
 * entfernen, down() laesst den Wert stehen.
 */
export class AddOrganizationOperatingMode1832000000000 implements MigrationInterface {
  name = 'AddOrganizationOperatingMode1832000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS organization_operating_mode_changes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        organization_id uuid NOT NULL
          REFERENCES organizations(id) ON DELETE CASCADE,
        from_mode varchar(20) NOT NULL,
        to_mode varchar(20) NOT NULL,
        reason text NOT NULL,
        changed_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        changed_by_name varchar(255) NULL,
        ip_address varchar(45) NULL,
        user_agent varchar(500) NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_org_operating_mode_changes_org_created"
         ON organization_operating_mode_changes (organization_id, created_at)`,
    );

    // ALTER TYPE ADD VALUE cannot run inside a transaction in PostgreSQL
    await queryRunner.commitTransaction();
    await queryRunner.query(
      `ALTER TYPE "admin_action" ADD VALUE IF NOT EXISTS 'set_operating_mode'`,
    );
    await queryRunner.startTransaction();
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS organization_operating_mode_changes`,
    );
    // Enum-Werte bleiben stehen.
  }
}
