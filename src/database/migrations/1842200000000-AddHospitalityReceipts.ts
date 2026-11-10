import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bewirtungsbelege (openeos-web#9, Idee von till-mueller).
 *
 * - `hospitality_receipts`: ausgestellter Bewirtungsbeleg mit eigener
 *   fortlaufender Nummer je Organisation und Jahr (`B-2026-0001`) und dem
 *   Schnappschuss aller Angaben (Verein, Positionen, MwSt, Trinkgeld,
 *   Zahlung, TSE). Unveraenderlich per Trigger wie `cash_point_closings`;
 *   Nachdrucke sind Kopien desselben Datensatzes. Aufbewahrt mit dem
 *   Steuerarchiv (10 Jahre).
 * - Die Nummer vergibt die Datenbank beim Einfuegen
 *   (`hospitality_receipt_counters`, Zeile je Organisation und Jahr,
 *   gesperrt bis zum Ende der Transaktion): rollt das Einfuegen zurueck,
 *   rollt auch der Zaehler zurueck — keine Luecken, keine Doppelten.
 *   Testbelege (Testbestellungen) haben keine Nummer.
 * - `hospitality_receipt_orders`: welche Bestellungen ein Beleg umfasst;
 *   jede Bestellung hoechstens einmal. Bestellungen mit echtem
 *   Bewirtungsbeleg lassen sich nicht loeschen; mit Testbestellungen geht
 *   auch ihr Testbeleg.
 * - `receipt_links`: Links auf Bewirtungsbelege (`kind`, `copy`).
 */
export class AddHospitalityReceipts1842200000000 implements MigrationInterface {
  name = 'AddHospitalityReceipts1842200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS hospitality_receipt_counters (
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        year int NOT NULL,
        last_number int NOT NULL DEFAULT 0,
        PRIMARY KEY (organization_id, year)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS hospitality_receipts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        year int NULL,
        sequence int NULL,
        number varchar(20) NULL,
        is_test boolean NOT NULL DEFAULT false,
        issued_at timestamptz NOT NULL DEFAULT now(),
        service_date date NOT NULL,
        recipient_name varchar(200) NULL,
        recipient_address varchar(500) NULL,
        total numeric(12,2) NOT NULL,
        tip numeric(12,2) NOT NULL DEFAULT 0,
        snapshot jsonb NOT NULL,
        device_id uuid NULL,
        user_id uuid NULL,
        waiter_id uuid NULL,
        actor_name varchar(255) NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_hospitality_receipts_org_number" UNIQUE (organization_id, number),
        CONSTRAINT "CHK_hospitality_receipts_number" CHECK (is_test = (number IS NULL))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_hospitality_receipts_org_issued" ON hospitality_receipts (organization_id, issued_at)`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS hospitality_receipt_orders (
        order_id uuid PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
        hospitality_receipt_id uuid NOT NULL REFERENCES hospitality_receipts(id) ON DELETE CASCADE,
        organization_id uuid NOT NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_hospitality_receipt_orders_receipt" ON hospitality_receipt_orders (hospitality_receipt_id)`,
    );

    // Nummer beim Einfuegen (echte Belege): B-JJJJ-NNNN je Organisation und
    // Jahr der Ausstellung (Ortszeit Europe/Berlin).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION hospitality_receipts_assign_number() RETURNS trigger AS $$
      DECLARE y int;
      BEGIN
        IF NEW.is_test THEN
          NEW.number := NULL; NEW.sequence := NULL; NEW.year := NULL;
          RETURN NEW;
        END IF;
        y := extract(year FROM (NEW.issued_at AT TIME ZONE 'Europe/Berlin'))::int;
        INSERT INTO hospitality_receipt_counters (organization_id, year, last_number)
             VALUES (NEW.organization_id, y, 1)
        ON CONFLICT (organization_id, year)
          DO UPDATE SET last_number = hospitality_receipt_counters.last_number + 1
        RETURNING last_number INTO NEW.sequence;
        NEW.year := y;
        NEW.number := 'B-' || y || '-' || lpad(NEW.sequence::text, 4, '0');
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS hospitality_receipts_number ON hospitality_receipts`,
    );
    await queryRunner.query(`
      CREATE TRIGGER hospitality_receipts_number
        BEFORE INSERT ON hospitality_receipts
        FOR EACH ROW EXECUTE FUNCTION hospitality_receipts_assign_number()
    `);

    // Unveraenderlich. Loeschen nur Testbelege und mit der Organisation.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION hospitality_receipts_immutable() RETURNS trigger AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = OLD.organization_id) THEN
          IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END IF;
        IF TG_OP = 'DELETE' THEN
          IF OLD.is_test THEN RETURN OLD; END IF;
          RAISE EXCEPTION 'hospitality receipts cannot be deleted (retention obligation)';
        END IF;
        RAISE EXCEPTION 'hospitality receipts are immutable';
      END
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS hospitality_receipts_immutable ON hospitality_receipts`,
    );
    await queryRunner.query(`
      CREATE TRIGGER hospitality_receipts_immutable
        BEFORE UPDATE OR DELETE ON hospitality_receipts
        FOR EACH ROW EXECUTE FUNCTION hospitality_receipts_immutable()
    `);

    // Zuordnung: unveraenderlich; Loeschen (mit der Bestellung) nur bei
    // Testbelegen — dann geht der Testbeleg mit — oder mit der Organisation.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION hospitality_receipt_orders_guard() RETURNS trigger AS $$
      DECLARE test boolean;
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          RAISE EXCEPTION 'hospitality receipt orders are immutable';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = OLD.organization_id) THEN
          RETURN OLD;
        END IF;
        SELECT is_test INTO test FROM hospitality_receipts WHERE id = OLD.hospitality_receipt_id;
        IF test IS NULL OR test THEN RETURN OLD; END IF;
        RAISE EXCEPTION 'orders with a hospitality receipt cannot be deleted (retention obligation)';
      END
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS hospitality_receipt_orders_guard ON hospitality_receipt_orders`,
    );
    await queryRunner.query(`
      CREATE TRIGGER hospitality_receipt_orders_guard
        BEFORE UPDATE OR DELETE ON hospitality_receipt_orders
        FOR EACH ROW EXECUTE FUNCTION hospitality_receipt_orders_guard()
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION hospitality_receipt_orders_drop_test() RETURNS trigger AS $$
      BEGIN
        DELETE FROM hospitality_receipts h
         WHERE h.id = OLD.hospitality_receipt_id AND h.is_test
           AND NOT EXISTS (SELECT 1 FROM hospitality_receipt_orders o
                            WHERE o.hospitality_receipt_id = h.id);
        RETURN NULL;
      END
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS hospitality_receipt_orders_drop_test ON hospitality_receipt_orders`,
    );
    await queryRunner.query(`
      CREATE TRIGGER hospitality_receipt_orders_drop_test
        AFTER DELETE ON hospitality_receipt_orders
        FOR EACH ROW EXECUTE FUNCTION hospitality_receipt_orders_drop_test()
    `);

    await queryRunner.query(`
      ALTER TABLE receipt_links
        ADD COLUMN IF NOT EXISTS kind varchar(20) NOT NULL DEFAULT 'receipt',
        ADD COLUMN IF NOT EXISTS hospitality_receipt_id uuid NULL REFERENCES hospitality_receipts(id) ON DELETE CASCADE,
        ADD COLUMN IF NOT EXISTS copy boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(
      `ALTER TABLE receipt_links DROP CONSTRAINT IF EXISTS "CHK_receipt_links_kind"`,
    );
    await queryRunner.query(`
      ALTER TABLE receipt_links ADD CONSTRAINT "CHK_receipt_links_kind"
        CHECK ((kind = 'receipt' AND hospitality_receipt_id IS NULL)
            OR (kind = 'hospitality' AND hospitality_receipt_id IS NOT NULL))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ n }] = (await queryRunner.query(
      `SELECT count(*)::int AS n FROM hospitality_receipts WHERE NOT is_test`,
    )) as { n: number }[];
    if (n > 0) {
      throw new Error(
        'Bewirtungsbelege vorhanden (Aufbewahrungspflicht) — Migration nicht zurueckrollbar',
      );
    }
    await queryRunner.query(
      `ALTER TABLE receipt_links DROP CONSTRAINT IF EXISTS "CHK_receipt_links_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE receipt_links DROP COLUMN IF EXISTS copy, DROP COLUMN IF EXISTS hospitality_receipt_id, DROP COLUMN IF EXISTS kind`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS hospitality_receipt_orders`);
    await queryRunner.query(`DROP TABLE IF EXISTS hospitality_receipts`);
    await queryRunner.query(
      `DROP TABLE IF EXISTS hospitality_receipt_counters`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS hospitality_receipt_orders_drop_test(), hospitality_receipt_orders_guard(), hospitality_receipts_immutable(), hospitality_receipts_assign_number()`,
    );
  }
}
