import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DSFinV-K (Kassenabschluss, Export) und Kassenbuch, openeos-api#102.
 * Nur Erweiterungen:
 *
 * - `cash_registers`: die eine Kasse je Organisation (Z_KASSE_ID =
 *   TSE-Client-ID) mit Zaehlern fuer BON_ID und Z_NR.
 * - `tse_transactions.bon_id`: fortlaufende Vorgangsnummer je Kasse, vom
 *   Trigger beim Einfuegen vergeben (lueckenlos, auch fuer den Abgleich und
 *   das Kassenbuch); bestehende Vorgaenge werden in Zeitfolge nummeriert.
 *   `cash_point_closing_id`: Abschluss, in dem der Vorgang steht.
 * - `cash_point_closings`: Kassenabschluesse, unveraenderlich (Trigger),
 *   mit den fertigen Zeilen aller DSFinV-K-Tabellen und Pruefsumme, damit
 *   Exporte reproduzierbar sind.
 * - `cashbook_entries`: Kassenbuch (Anfangsbestand, Einlage, Entnahme,
 *   Kassensturz).
 * - `tse_units.certificate`: Zertifikat der TSE (Stamm_TSE).
 *
 * `down()` entfernt nur, solange keine Abschluesse existieren
 * (Aufbewahrungspflicht).
 */
export class AddDsfinvk1836000000000 implements MigrationInterface {
  name = 'AddDsfinvk1836000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS cash_registers (
        organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE RESTRICT,
        client_id varchar(30) NOT NULL,
        last_bon_id bigint NOT NULL DEFAULT 0,
        last_z_nr int NOT NULL DEFAULT 0,
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        updated_at timestamp with time zone NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `ALTER TABLE tse_units ADD COLUMN IF NOT EXISTS certificate text NULL`,
    );

    await queryRunner.query(`
      ALTER TABLE tse_transactions
        ADD COLUMN IF NOT EXISTS bon_id bigint NULL,
        ADD COLUMN IF NOT EXISTS cash_point_closing_id uuid NULL
    `);

    // Bestehende Vorgaenge in Zeitfolge nummerieren (je Organisation).
    await queryRunner.query(`
      UPDATE tse_transactions t SET bon_id = n.rn
        FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY organization_id ORDER BY created_at, id) AS rn
            FROM tse_transactions
        ) n
       WHERE n.id = t.id AND t.bon_id IS NULL
    `);
    await queryRunner.query(`
      INSERT INTO cash_registers (organization_id, client_id, last_bon_id)
      SELECT organization_id, MIN(client_id), MAX(bon_id)
        FROM tse_transactions GROUP BY organization_id
      ON CONFLICT (organization_id) DO NOTHING
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tse_transactions_bon_id"
         ON tse_transactions (organization_id, bon_id) WHERE bon_id IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tse_transactions_unclosed"
         ON tse_transactions (organization_id, created_at)
         WHERE cash_point_closing_id IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tse_transactions_closing"
         ON tse_transactions (cash_point_closing_id)`,
    );

    // BON_ID beim Einfuegen: Zaehler der Kasse in derselben Transaktion
    // erhoehen — rollt die Einfuegung zurueck, rollt auch der Zaehler zurueck.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION tse_transactions_assign_bon_id() RETURNS trigger AS $$
      BEGIN
        IF NEW.bon_id IS NULL THEN
          INSERT INTO cash_registers (organization_id, client_id, last_bon_id)
               VALUES (NEW.organization_id, NEW.client_id, 1)
          ON CONFLICT (organization_id)
            DO UPDATE SET last_bon_id = cash_registers.last_bon_id + 1, updated_at = now()
          RETURNING last_bon_id INTO NEW.bon_id;
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS tse_transactions_bon_id ON tse_transactions`,
    );
    await queryRunner.query(`
      CREATE TRIGGER tse_transactions_bon_id
        BEFORE INSERT ON tse_transactions
        FOR EACH ROW EXECUTE FUNCTION tse_transactions_assign_bon_id()
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS cash_point_closings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        register_id varchar(30) NOT NULL,
        z_nr int NOT NULL,
        business_date date NOT NULL,
        period_from timestamp with time zone NULL,
        period_to timestamp with time zone NOT NULL,
        closing_created_at timestamp with time zone NOT NULL,
        trigger varchar(20) NOT NULL,
        created_by_user_id uuid NULL,
        first_bon_id bigint NULL,
        last_bon_id bigint NULL,
        transaction_count int NOT NULL DEFAULT 0,
        totals jsonb NOT NULL,
        master_data jsonb NOT NULL,
        rows jsonb NOT NULL,
        content_sha256 char(64) NOT NULL,
        export_file_path text NULL,
        export_sha256 char(64) NULL,
        export_size_bytes bigint NULL,
        exported_at timestamp with time zone NULL,
        archived_at timestamp with time zone NULL,
        archive_ref varchar(255) NULL,
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        updated_at timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_cash_point_closings_org_z_nr" UNIQUE (organization_id, z_nr),
        CONSTRAINT "CHK_cash_point_closings_trigger" CHECK (trigger IN ('scheduled', 'manual'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_cash_point_closings_org_date"
         ON cash_point_closings (organization_id, business_date)`,
    );
    // Unveraenderlich: Inhalt, Nummer und Summen eines Abschlusses bleiben,
    // wie sie sind; nur Ablage-Felder (Export-Datei, Archiv) duerfen sich
    // aendern. Loeschen ist ausgeschlossen.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION cash_point_closings_immutable() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'cash point closings cannot be deleted (retention obligation)';
        END IF;
        IF NEW.organization_id <> OLD.organization_id OR NEW.z_nr <> OLD.z_nr
           OR NEW.register_id <> OLD.register_id
           OR NEW.business_date <> OLD.business_date
           OR NEW.closing_created_at <> OLD.closing_created_at
           OR NEW.period_to <> OLD.period_to
           OR NEW.content_sha256 <> OLD.content_sha256
           OR NEW.rows::text <> OLD.rows::text
           OR NEW.totals::text <> OLD.totals::text
           OR NEW.master_data::text <> OLD.master_data::text THEN
          RAISE EXCEPTION 'cash point closings are immutable';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS cash_point_closings_immutable ON cash_point_closings`,
    );
    await queryRunner.query(`
      CREATE TRIGGER cash_point_closings_immutable
        BEFORE UPDATE OR DELETE ON cash_point_closings
        FOR EACH ROW EXECUTE FUNCTION cash_point_closings_immutable()
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS cashbook_entries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        business_date date NOT NULL,
        type varchar(20) NOT NULL,
        amount numeric(12,2) NOT NULL,
        counted_amount numeric(12,2) NULL,
        expected_amount numeric(12,2) NULL,
        scope varchar(20) NOT NULL DEFAULT 'device',
        note varchar(500) NULL,
        device_id uuid NULL,
        user_id uuid NULL,
        tse_transaction_id uuid NULL,
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        updated_at timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_cashbook_entries_type"
          CHECK (type IN ('opening_balance', 'deposit', 'withdrawal', 'cash_count')),
        CONSTRAINT "CHK_cashbook_entries_scope" CHECK (scope IN ('device', 'register'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_cashbook_entries_org_date"
         ON cashbook_entries (organization_id, business_date, created_at)`,
    );

    await queryRunner.commitTransaction();
    for (const value of ['dsfinvk_closing_requested', 'dsfinvk_exported']) {
      await queryRunner.query(
        `ALTER TYPE "admin_action" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
    await queryRunner.startTransaction();
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT 1 FROM cash_point_closings LIMIT 1`,
    )) as unknown[];
    if (rows.length > 0) {
      throw new Error(
        'cash_point_closings contains data (retention obligation) - not dropping it',
      );
    }
    await queryRunner.query(`DROP TABLE IF EXISTS cashbook_entries`);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS cash_point_closings_immutable ON cash_point_closings`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS cash_point_closings`);
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS cash_point_closings_immutable()`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS tse_transactions_bon_id ON tse_transactions`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS tse_transactions_assign_bon_id()`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_tse_transactions_bon_id"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_tse_transactions_unclosed"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_tse_transactions_closing"`,
    );
    await queryRunner.query(
      `ALTER TABLE tse_transactions DROP COLUMN IF EXISTS cash_point_closing_id, DROP COLUMN IF EXISTS bon_id`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS cash_registers`);
    await queryRunner.query(
      `ALTER TABLE tse_units DROP COLUMN IF EXISTS certificate`,
    );
  }
}
