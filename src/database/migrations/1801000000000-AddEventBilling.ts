import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Event billing phase 1: pay-per-event activation.
 *
 * Every existing event is grandfathered in as `waived` so nothing that was
 * already created (or already active) gets blocked by the new activation
 * gate once it ships.
 */
export class AddEventBilling1801000000000 implements MigrationInterface {
  name = 'AddEventBilling1801000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE events
      ADD COLUMN IF NOT EXISTS billing_status varchar(20) NOT NULL DEFAULT 'none',
      ADD COLUMN IF NOT EXISTS paid_at timestamptz NULL,
      ADD COLUMN IF NOT EXISTS stripe_checkout_session_id varchar(255) NULL,
      ADD COLUMN IF NOT EXISTS price_charged numeric(10,2) NULL
    `);

    await queryRunner.query(`
      ALTER TABLE organizations
      ADD COLUMN IF NOT EXISTS billing_mode varchar(20) NOT NULL DEFAULT 'invoice',
      ADD COLUMN IF NOT EXISTS event_price_override numeric(10,2) NULL
    `);

    // Grandfather: nothing already created may be blocked by the new gate.
    await queryRunner.query(`UPDATE events SET billing_status = 'waived'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE organizations
      DROP COLUMN IF EXISTS billing_mode,
      DROP COLUMN IF EXISTS event_price_override
    `);

    await queryRunner.query(`
      ALTER TABLE events
      DROP COLUMN IF EXISTS billing_status,
      DROP COLUMN IF EXISTS paid_at,
      DROP COLUMN IF EXISTS stripe_checkout_session_id,
      DROP COLUMN IF EXISTS price_charged
    `);
  }
}
