import { MigrationInterface, QueryRunner } from 'typeorm';

export class MigrateToModulePermissions1768600000000 implements MigrationInterface {
  name = 'MigrateToModulePermissions1768600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Add 'member' to organization_role enum
    // ALTER TYPE ADD VALUE cannot run inside a transaction, so we commit first
    // and handle this via raw connection
    await queryRunner.commitTransaction();
    await queryRunner.query(`
      ALTER TYPE "organization_role" ADD VALUE IF NOT EXISTS 'member';
    `);
    await queryRunner.startTransaction();

    // 2. Migrate existing roles to 'member' with appropriate permissions
    // Managers get all permissions
    await queryRunner.query(`
      UPDATE user_organizations
      SET role = 'member',
          permissions = '{"products":true,"events":true,"devices":true,"members":true,"shiftPlans":true}'
      WHERE role = 'manager';
    `);

    // Cashier, kitchen, delivery get no module permissions (they can still do orders/payments)
    await queryRunner.query(`
      UPDATE user_organizations
      SET role = 'member',
          permissions = '{"products":false,"events":false,"devices":false,"members":false,"shiftPlans":false}'
      WHERE role IN ('cashier', 'kitchen', 'delivery');
    `);

    // 3. Migrate invitations
    await queryRunner.query(`
      UPDATE invitations SET role = 'member' WHERE role != 'admin';
    `);

    // 4. Add permissions column to invitations table
    await queryRunner.query(`
      ALTER TABLE invitations ADD COLUMN IF NOT EXISTS permissions jsonb DEFAULT '{}';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Revert invitations permissions column
    await queryRunner.query(`
      ALTER TABLE invitations DROP COLUMN IF EXISTS permissions;
    `);

    // Revert member roles back to cashier (safe default)
    await queryRunner.query(`
      UPDATE invitations SET role = 'cashier' WHERE role = 'member';
    `);

    // Revert user_organizations: members with all permissions -> manager, others -> cashier
    await queryRunner.query(`
      UPDATE user_organizations
      SET role = 'manager'
      WHERE role = 'member'
        AND permissions->>'products' = 'true'
        AND permissions->>'events' = 'true';
    `);

    await queryRunner.query(`
      UPDATE user_organizations
      SET role = 'cashier'
      WHERE role = 'member';
    `);

    // Note: Cannot remove enum value in PostgreSQL easily, 'member' will remain
  }
}
