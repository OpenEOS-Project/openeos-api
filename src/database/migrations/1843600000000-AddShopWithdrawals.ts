import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Widerrufe von Shop-Bestellungen ueber die elektronische Widerrufsfunktion
 * (§ 356a BGB) — nur wenn der Verein in den rechtlichen Angaben ein
 * Widerrufsrecht eingeschaltet hat (`settings.legal.withdrawalRight`).
 * Geloescht 36 Monate nach dem Eingang (Loeschlauf `shop_withdrawals`).
 */
export class AddShopWithdrawals1843600000000 implements MigrationInterface {
  name = 'AddShopWithdrawals1843600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS shop_withdrawals (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        received_at timestamp with time zone NOT NULL DEFAULT now(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
        order_reference varchar(100) NOT NULL,
        name varchar(200) NOT NULL,
        email varchar(255) NOT NULL,
        message text,
        club_notified_at timestamp with time zone,
        confirmation_sent_at timestamp with time zone
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_shop_withdrawals_org_received
        ON shop_withdrawals (organization_id, received_at DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_shop_withdrawals_event
        ON shop_withdrawals (event_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS shop_withdrawals`);
  }
}
