import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Auszahlung von Kartentrinkgeld an angestellte Bedienungen (Steuerberater
 * 2026-11-10, Frage 5): eigener, TSE-gesicherter Beleg mit TrinkgeldAN −x
 * und Bar −x, Empfaenger und Quittung. Nur fuer Bedienungen mit
 * „Arbeitnehmer (Lohnkonto)“ (`waiters.is_employee`); bei Ehrenamtlichen
 * gehoert das Kartentrinkgeld dem Verein (TrinkgeldAG). Die Auszahlung
 * mindert den Soll-Bestand der Schublade.
 *
 * Unveraenderlich bis auf `tse_transaction_id` und `printed_at` (Trigger,
 * wie `waiter_settlements`); Empfaengername als Schnappschuss.
 */
export class AddTipPayouts1842600000000 implements MigrationInterface {
  name = 'AddTipPayouts1842600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS tip_payouts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        event_id uuid NULL,
        waiter_id uuid NOT NULL,
        waiter_name varchar(100) NOT NULL,
        amount numeric(12,2) NOT NULL CHECK (amount > 0),
        is_test boolean NOT NULL DEFAULT false,
        settlement_id uuid NULL,
        device_id uuid NULL,
        paid_by_user_id uuid NULL,
        paid_by_waiter_id uuid NULL,
        note varchar(500) NULL,
        tse_transaction_id uuid NULL,
        printed_at timestamp with time zone NULL,
        created_at timestamp with time zone NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tip_payouts_org_waiter" ON tip_payouts (organization_id, waiter_id, created_at)`,
    );
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION tip_payouts_immutable() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.is_test THEN RETURN OLD; END IF;
          IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = OLD.organization_id) THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION 'tip_payouts are immutable';
        END IF;
        IF (NEW.organization_id, NEW.waiter_id, NEW.waiter_name, NEW.amount, NEW.is_test, NEW.created_at)
             IS DISTINCT FROM
           (OLD.organization_id, OLD.waiter_id, OLD.waiter_name, OLD.amount, OLD.is_test, OLD.created_at) THEN
          RAISE EXCEPTION 'tip_payouts are immutable';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS tip_payouts_immutable ON tip_payouts`,
    );
    await queryRunner.query(`
      CREATE TRIGGER tip_payouts_immutable
        BEFORE UPDATE OR DELETE ON tip_payouts
        FOR EACH ROW EXECUTE FUNCTION tip_payouts_immutable()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS tip_payouts`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS tip_payouts_immutable()`);
  }
}
