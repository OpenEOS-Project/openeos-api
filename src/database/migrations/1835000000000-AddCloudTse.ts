import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cloud-TSE (Swissbit), tse-swissbit-plan.md §8. Nur Erweiterungen
 * (expand): neue Tabellen, eine neue Spalte mit Standardwert, neue
 * Werte im Enum `admin_action`.
 *
 * - `tse_units`: eine TSE je Organisation (hoechstens eine in
 *   `creating`/`active`), Access Token verschluesselt.
 * - `tse_transactions`: jeder abgesicherte Vorgang; ohne Fremdschluessel
 *   auf Bestellungen/Zahlungen, damit nichts davon beim Aufraeumen von
 *   Testbestellungen verschwindet (Aufbewahrung, Trainingsbuchungen).
 * - `tse_outages`: Ausfallprotokoll, hoechstens ein offener Ausfall je TSE.
 * - `tse_exports`: TAR-Exporte im eigenen Archiv (spaeter ELeFANT).
 * - `organizations.tse_active`: gepflegt vom TSE-Modul, liest
 *   `hasActiveTse` ohne Zusatzabfrage.
 *
 * `down()` entfernt die Tabellen nur, solange sie leer sind — TSE-Daten
 * unterliegen der Aufbewahrungspflicht.
 */
export class AddCloudTse1835000000000 implements MigrationInterface {
  name = 'AddCloudTse1835000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE organizations
         ADD COLUMN IF NOT EXISTS tse_active boolean NOT NULL DEFAULT false`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS tse_units (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        provider varchar(20) NOT NULL DEFAULT 'swissbit',
        state varchar(20) NOT NULL,
        serial_number varchar(128) NULL,
        access_token_enc text NULL,
        creation_id varchar(100) NULL,
        product_type varchar(40) NOT NULL,
        client_id varchar(30) NOT NULL,
        client_registered_at timestamp with time zone NULL,
        public_key text NULL,
        signature_algorithm varchar(64) NULL,
        log_time_format varchar(32) NULL,
        certification_id varchar(100) NULL,
        certificate_expires_at timestamp with time zone NULL,
        trigger varchar(20) NOT NULL,
        trigger_event_id uuid NULL,
        created_by_user_id uuid NULL,
        override_reason text NULL,
        activated_at timestamp with time zone NULL,
        failed_at timestamp with time zone NULL,
        deactivated_at timestamp with time zone NULL,
        deactivated_by_user_id uuid NULL,
        deactivation_reason text NULL,
        last_error_code varchar(60) NULL,
        last_error_message varchar(500) NULL,
        last_error_at timestamp with time zone NULL,
        attempts int NOT NULL DEFAULT 0,
        job_locked_until timestamp with time zone NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        updated_at timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_tse_units_state"
          CHECK (state IN ('creating', 'active', 'failed', 'deactivated'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tse_units_org"
         ON tse_units (organization_id, created_at)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tse_units_live_per_org"
         ON tse_units (organization_id) WHERE state IN ('creating', 'active')`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tse_units_serial"
         ON tse_units (serial_number) WHERE serial_number IS NOT NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS tse_transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        tse_unit_id uuid NULL REFERENCES tse_units(id) ON DELETE RESTRICT,
        event_id uuid NULL,
        kind varchar(30) NOT NULL,
        process_type varchar(40) NOT NULL,
        process_data text NOT NULL,
        training boolean NOT NULL DEFAULT false,
        status varchar(20) NOT NULL,
        client_id varchar(30) NOT NULL,
        serial_number varchar(128) NULL,
        transaction_number bigint NULL,
        signature_counter bigint NULL,
        start_time timestamp with time zone NULL,
        finish_time timestamp with time zone NULL,
        signature_value text NULL,
        amount numeric(12,2) NULL,
        lines jsonb NULL,
        error_code varchar(60) NULL,
        error_message varchar(500) NULL,
        aborted_at timestamp with time zone NULL,
        recovered_at timestamp with time zone NULL,
        terminal varchar(64) NULL,
        user_id uuid NULL,
        order_id uuid NULL,
        payment_id uuid NULL,
        refund_id uuid NULL,
        pfand_return_id uuid NULL,
        references_tse_transaction_id uuid NULL,
        start_request_id varchar(64) NULL,
        finish_request_id varchar(64) NULL,
        duration_ms int NULL,
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        updated_at timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_tse_transactions_status"
          CHECK (status IN ('pending', 'signed', 'training', 'failed'))
      )
    `);
    for (const [name, columns] of [
      ['IDX_tse_transactions_org_created', 'organization_id, created_at'],
      ['IDX_tse_transactions_order', 'order_id'],
      ['IDX_tse_transactions_payment', 'payment_id'],
      ['IDX_tse_transactions_refund', 'refund_id'],
      ['IDX_tse_transactions_pfand_return', 'pfand_return_id'],
      ['IDX_tse_transactions_unit_number', 'tse_unit_id, transaction_number'],
    ] as const) {
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "${name}" ON tse_transactions (${columns})`,
      );
    }
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tse_transactions_open"
         ON tse_transactions (tse_unit_id, created_at)
         WHERE status IN ('pending', 'failed')`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS tse_outages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        tse_unit_id uuid NOT NULL REFERENCES tse_units(id) ON DELETE RESTRICT,
        started_at timestamp with time zone NOT NULL,
        ended_at timestamp with time zone NULL,
        reason varchar(60) NOT NULL,
        last_error_message varchar(500) NULL,
        failed_count int NOT NULL DEFAULT 0,
        notified_at timestamp with time zone NULL,
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        updated_at timestamp with time zone NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tse_outages_org"
         ON tse_outages (organization_id, started_at)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tse_outages_open"
         ON tse_outages (tse_unit_id) WHERE ended_at IS NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS tse_exports (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        tse_unit_id uuid NOT NULL REFERENCES tse_units(id) ON DELETE RESTRICT,
        serial_number varchar(128) NOT NULL,
        swissbit_export_id varchar(100) NOT NULL,
        status varchar(20) NOT NULL,
        trigger varchar(20) NOT NULL,
        filename varchar(255) NULL,
        file_path text NULL,
        sha256 char(64) NULL,
        size_bytes bigint NULL,
        period_from timestamp with time zone NULL,
        period_to timestamp with time zone NULL,
        swissbit_created_at timestamp with time zone NULL,
        downloaded_at timestamp with time zone NULL,
        remote_deleted_at timestamp with time zone NULL,
        archived_at timestamp with time zone NULL,
        archive_ref varchar(255) NULL,
        requested_by_user_id uuid NULL,
        error_code varchar(60) NULL,
        error_message varchar(500) NULL,
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        updated_at timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_tse_exports_status"
          CHECK (status IN ('pending', 'downloaded', 'failed'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tse_exports_org"
         ON tse_exports (organization_id, created_at)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tse_exports_unit_export"
         ON tse_exports (tse_unit_id, swissbit_export_id)`,
    );

    // Enum-Werte lassen sich nicht in derselben Transaktion verwenden, in
    // der sie entstehen — wie in AddOrganizationCountryCashPolicy.
    await queryRunner.commitTransaction();
    for (const value of [
      'tse_integration_enabled',
      'tse_integration_disabled',
      'tse_creation_requested',
      'tse_activated',
      'tse_creation_failed',
      'tse_deactivated',
      'tse_export_requested',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "admin_action" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
    await queryRunner.startTransaction();
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'tse_exports',
      'tse_outages',
      'tse_transactions',
      'tse_units',
    ]) {
      const rows = (await queryRunner.query(
        `SELECT 1 FROM ${table} LIMIT 1`,
      )) as unknown[];
      if (rows.length > 0) {
        throw new Error(
          `${table} contains data (retention obligation) - not dropping it`,
        );
      }
    }
    await queryRunner.query(`DROP TABLE IF EXISTS tse_exports`);
    await queryRunner.query(`DROP TABLE IF EXISTS tse_outages`);
    await queryRunner.query(`DROP TABLE IF EXISTS tse_transactions`);
    await queryRunner.query(`DROP TABLE IF EXISTS tse_units`);
    await queryRunner.query(
      `ALTER TABLE organizations DROP COLUMN IF EXISTS tse_active`,
    );
    // Enum-Werte bleiben (Postgres kann sie nicht entfernen).
  }
}
