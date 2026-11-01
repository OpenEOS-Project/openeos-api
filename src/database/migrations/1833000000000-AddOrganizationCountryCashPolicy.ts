import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bargeld-Regel je Land (2026-11-01):
 *
 * - `organizations.country` (ISO 3166-1 alpha-2): einzige Quelle fuer das
 *   Land. Uebernommen wird ein gueltiger Code aus
 *   `settings.address.country`, falls dort schon einer steht.
 * - `organizations.cash_policy_legacy`: Bestandsschutz. Jede Organisation,
 *   die es vor dieser Migration gibt, bekommt `true` und verhaelt sich wie
 *   bisher; neue Organisationen starten mit `false`.
 * - `orders.closed_without_payment_at`: „Ohne Zahlung abschließen“.
 * - `organization_cash_policy_changes`: Verlauf (Land, Wechsel der Regel).
 * - Zwei Werte im Admin-Protokoll.
 *
 * Nur Erweiterung (expand). Der Standard `true` beim Anlegen der Spalte
 * erfasst genau die bestehenden Zeilen; danach gilt `false`.
 */
export class AddOrganizationCountryCashPolicy1833000000000 implements MigrationInterface {
  name = 'AddOrganizationCountryCashPolicy1833000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS country varchar(2) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE organizations
         ADD COLUMN IF NOT EXISTS cash_policy_legacy boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE organizations ALTER COLUMN cash_policy_legacy SET DEFAULT false`,
    );
    await queryRunner.query(`
      UPDATE organizations
         SET country = upper(btrim(settings->'address'->>'country'))
       WHERE country IS NULL
         AND jsonb_typeof(settings->'address') = 'object'
         AND upper(btrim(settings->'address'->>'country')) ~ '^[A-Z]{2}$'
    `);
    await queryRunner.query(
      `ALTER TABLE orders
         ADD COLUMN IF NOT EXISTS closed_without_payment_at timestamp with time zone NULL`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS organization_cash_policy_changes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        organization_id uuid NOT NULL
          REFERENCES organizations(id) ON DELETE CASCADE,
        kind varchar(20) NOT NULL,
        from_value varchar(20) NULL,
        to_value varchar(20) NOT NULL,
        reason text NULL,
        by_support boolean NOT NULL DEFAULT false,
        changed_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        changed_by_name varchar(255) NULL,
        ip_address varchar(45) NULL,
        user_agent varchar(500) NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_org_cash_policy_changes_org_created"
         ON organization_cash_policy_changes (organization_id, created_at)`,
    );

    // ALTER TYPE ADD VALUE cannot run inside a transaction in PostgreSQL
    await queryRunner.commitTransaction();
    await queryRunner.query(
      `ALTER TYPE "admin_action" ADD VALUE IF NOT EXISTS 'set_organization_country'`,
    );
    await queryRunner.query(
      `ALTER TYPE "admin_action" ADD VALUE IF NOT EXISTS 'set_cash_policy'`,
    );
    await queryRunner.startTransaction();
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS organization_cash_policy_changes`,
    );
    await queryRunner.query(
      `ALTER TABLE orders DROP COLUMN IF EXISTS closed_without_payment_at`,
    );
    await queryRunner.query(
      `ALTER TABLE organizations DROP COLUMN IF EXISTS cash_policy_legacy`,
    );
    await queryRunner.query(
      `ALTER TABLE organizations DROP COLUMN IF EXISTS country`,
    );
    // Enum-Werte bleiben stehen.
  }
}
