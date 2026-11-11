import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wertmarken (Steuerberater 2026-11-10, Frage 13): Markentypen je
 * Organisation, Verkauf und Ruecktausch an der Kasse und die Einloesung
 * als Zahlungsmittel.
 *
 * - `token_types`: Markentyp mit Nennwert, Art (Mehrzweck-/Einzweck-
 *   gutschein, § 3 Abs. 14/15 UStG), Satz bei Einzweck, Beschraenkung auf
 *   Kategorien/Artikel, Farbe, Ruecktausch erlaubt.
 * - `token_transactions`: Verkauf (`sale`) und Ruecktausch (`buyback`),
 *   unveraenderlich, mit Belegnummer `W-JJJJMMTT-NNNN`.
 * - `payments.token_amount`/`token_lines`: mit Wertmarken beglichener Teil
 *   einer Zahlung. `amount` bleibt das erhaltene Geld in der Zahlart der
 *   Zahlung — Kassenbuch und Abrechnungen rechnen damit weiter richtig.
 *   Eine Zahlung nur mit Marken hat die Zahlart `tokens` und `amount` 0.
 * - `tse_transactions.token_transaction_id`: Bezug des Kassenbelegs.
 */
export class AddTokens1842800000000 implements MigrationInterface {
  name = 'AddTokens1842800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ALTER TYPE … ADD VALUE geht nicht zusammen mit anderen Aenderungen in
    // einer Transaktion, die den neuen Wert nutzen.
    await queryRunner.commitTransaction();
    await queryRunner.query(
      `ALTER TYPE "payment_method" ADD VALUE IF NOT EXISTS 'tokens'`,
    );
    await queryRunner.startTransaction();

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS token_types (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        event_id uuid NULL REFERENCES events(id) ON DELETE SET NULL,
        name varchar(100) NOT NULL,
        value numeric(10,2) NOT NULL CHECK (value > 0),
        kind varchar(20) NOT NULL DEFAULT 'multi_purpose'
          CHECK (kind IN ('multi_purpose', 'single_purpose')),
        vat_rate numeric(5,2) NULL,
        allowed_category_ids uuid[] NOT NULL DEFAULT '{}',
        allowed_product_ids uuid[] NOT NULL DEFAULT '{}',
        color varchar(7) NULL,
        buyback_allowed boolean NOT NULL DEFAULT false,
        is_active boolean NOT NULL DEFAULT true,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_token_types_single_purpose_rate"
          CHECK (kind = 'multi_purpose' OR vat_rate IS NOT NULL)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_token_types_org" ON token_types (organization_id, is_active)`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS token_transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        event_id uuid NULL,
        kind varchar(20) NOT NULL CHECK (kind IN ('sale', 'buyback')),
        transaction_number varchar(50) NOT NULL,
        lines jsonb NOT NULL DEFAULT '[]',
        total_amount numeric(10,2) NOT NULL,
        tax_lines jsonb NOT NULL DEFAULT '[]',
        payment_method varchar(20) NOT NULL,
        provider_transaction_id varchar(255) NULL,
        amount_received numeric(10,2) NULL,
        device_id uuid NULL,
        user_id uuid NULL,
        waiter_id uuid NULL,
        actor_name varchar(255) NULL,
        reason text NULL,
        is_test boolean NOT NULL DEFAULT false,
        client_request_id uuid NULL,
        metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_token_transactions_sign"
          CHECK ((kind = 'sale' AND total_amount > 0) OR (kind = 'buyback' AND total_amount < 0))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_token_transactions_org_created" ON token_transactions (organization_id, created_at)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_token_transactions_event" ON token_transactions (event_id)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_token_transactions_number" ON token_transactions (organization_id, transaction_number)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_token_transactions_request" ON token_transactions (organization_id, client_request_id) WHERE client_request_id IS NOT NULL`,
    );
    // Unveraenderlich (Einzelaufzeichnung): Korrektur nur ueber einen
    // weiteren Vorgang. Loeschen bleibt fuer Testbuchungen und das
    // Aufraeumen geloeschter Organisationen moeglich.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION token_transactions_immutable() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'token_transactions are immutable';
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS token_transactions_no_update ON token_transactions;
      CREATE TRIGGER token_transactions_no_update
        BEFORE UPDATE ON token_transactions
        FOR EACH ROW EXECUTE FUNCTION token_transactions_immutable()
    `);

    await queryRunner.query(`
      ALTER TABLE payments
        ADD COLUMN IF NOT EXISTS token_amount numeric(10,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS token_lines jsonb NOT NULL DEFAULT '[]'
    `);

    await queryRunner.query(`
      ALTER TABLE tse_transactions
        ADD COLUMN IF NOT EXISTS token_transaction_id uuid NULL
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tse_transactions_token_transaction" ON tse_transactions (token_transaction_id)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_tse_transactions_token_transaction"`,
    );
    await queryRunner.query(
      `ALTER TABLE tse_transactions DROP COLUMN IF EXISTS token_transaction_id`,
    );
    await queryRunner.query(`
      ALTER TABLE payments
        DROP COLUMN IF EXISTS token_lines,
        DROP COLUMN IF EXISTS token_amount
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS token_transactions_no_update ON token_transactions`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS token_transactions_immutable()`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS token_transactions`);
    await queryRunner.query(`DROP TABLE IF EXISTS token_types`);
    // Der Enum-Wert 'tokens' bleibt (Postgres kann Werte nicht entfernen).
  }
}
