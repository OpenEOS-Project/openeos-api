import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bedienungen: Kassenprofile mit PIN fuer gemeinsam genutzte Kassen
 * (bedienungen-plan.md §4, Phasen P1 und P2).
 *
 * - `waiters`: Bedienung ohne Konto und ohne E-Mail (Name, Kurzname,
 *   Farbe, Rolle, Rechte). `event_id` leer = organisationsweit.
 * - `pin_credentials`: ein PIN-Raum je Organisation fuer Mitglieder und
 *   Bedienungen. Gespeichert wird nur HMAC-SHA256(PIN_PEPPER,
 *   "<orgId>:<pin>"); die Datenbank erzwingt die Eindeutigkeit
 *   (`UNIQUE (organization_id, pin_lookup)`), das Nachschlagen ist O(1).
 *   `pepper_id` ist ein kurzer Fingerabdruck des Peppers: wird er
 *   gewechselt, erkennt die API alte Eintraege (PIN neu vergeben).
 *   Mitglieds-PINs (bcrypt in `user_organizations.pin`) wandern bei der
 *   naechsten erfolgreichen Eingabe hierher.
 * - `waiter_sessions`: Anmeldung einer Bedienung bzw. eines Mitglieds an
 *   einem Geraet. Gespeichert ist nur der SHA-256 des Tokens.
 * - Zuordnungsspalten an Bestellungen, Positionen, Zahlungen (mit
 *   Trinkgeld je Zahlung), Erstattungen, Pfand-Auszahlungen,
 *   Bestell-Ereignissen, Kassenbuch und TSE-Vorgaengen
 *   (`operator_name` = Namens-Snapshot fuer BEDIENER_NAME der DSFinV-K).
 * - `organizations.waiter_limit`: eigene Obergrenze (Super-Admin), sonst
 *   WAITERS_PER_ORGANIZATION_LIMIT (200).
 * - Geraete mit `requirePin: true` bekommen `waiterMode: 'shared'`
 *   (Entscheidung 15): die PIN ist dort ab jetzt fuer jede Buchung Pflicht.
 */
export class AddWaiters1841300000000 implements MigrationInterface {
  name = 'AddWaiters1841300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS waiters (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        event_id uuid NULL REFERENCES events(id) ON DELETE CASCADE,
        name varchar(100) NOT NULL,
        short_name varchar(12) NULL,
        color varchar(7) NULL,
        role varchar(20) NOT NULL DEFAULT 'service',
        permissions jsonb NOT NULL DEFAULT '{}',
        wallet boolean NULL,
        user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        source_registration_group_id uuid NULL,
        is_active boolean NOT NULL DEFAULT true,
        last_used_at timestamptz NULL,
        anonymized_at timestamptz NULL,
        created_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_waiters_role" CHECK (role IN ('service', 'lead'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_waiters_org_active" ON waiters (organization_id, is_active)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_waiters_event" ON waiters (event_id) WHERE event_id IS NOT NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS pin_credentials (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        owner_type varchar(10) NOT NULL,
        owner_id uuid NOT NULL,
        pin_lookup char(64) NOT NULL,
        pepper_id char(8) NOT NULL,
        pin_length smallint NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_pin_credentials_owner_type" CHECK (owner_type IN ('member', 'waiter')),
        CONSTRAINT "UQ_pin_credentials_lookup" UNIQUE (organization_id, pin_lookup),
        CONSTRAINT "UQ_pin_credentials_owner" UNIQUE (owner_type, owner_id)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS waiter_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        event_id uuid NULL REFERENCES events(id) ON DELETE SET NULL,
        waiter_id uuid NULL REFERENCES waiters(id) ON DELETE CASCADE,
        user_id uuid NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash char(64) NOT NULL,
        started_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        ended_at timestamptz NULL,
        end_reason varchar(20) NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_waiter_sessions_token" UNIQUE (token_hash),
        CONSTRAINT "CHK_waiter_sessions_owner" CHECK ((waiter_id IS NULL) <> (user_id IS NULL))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_waiter_sessions_device_open" ON waiter_sessions (device_id) WHERE ended_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_waiter_sessions_waiter" ON waiter_sessions (waiter_id) WHERE waiter_id IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_waiter_sessions_org_started" ON waiter_sessions (organization_id, started_at)`,
    );

    // Zuordnung in den Buchungen (Bedienung oder Mitglied).
    const fk = (table: string, column: string) =>
      queryRunner.query(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} uuid NULL REFERENCES waiters(id) ON DELETE SET NULL`,
      );
    await fk('orders', 'created_by_waiter_id');
    await fk('orders', 'waiter_id');
    await fk('order_items', 'added_by_waiter_id');
    await queryRunner.query(
      `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS added_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL`,
    );
    await fk('payments', 'processed_by_waiter_id');
    await fk('payments', 'wallet_waiter_id');
    await queryRunner.query(
      `ALTER TABLE payments ADD COLUMN IF NOT EXISTS tip_amount numeric(10,2) NOT NULL DEFAULT 0`,
    );
    await fk('refunds', 'waiter_id');
    await fk('refunds', 'approved_by_waiter_id');
    await queryRunner.query(
      `ALTER TABLE refunds ADD COLUMN IF NOT EXISTS approved_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL`,
    );
    await fk('pfand_returns', 'waiter_id');
    await fk('order_events', 'waiter_id');
    await fk('cashbook_entries', 'waiter_id');
    // Steuerarchiv: ohne Fremdschluessel (bleibt zehn Jahre, auch wenn die
    // Bedienung geloescht oder anonymisiert ist).
    await queryRunner.query(
      `ALTER TABLE tse_transactions ADD COLUMN IF NOT EXISTS waiter_id uuid NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE tse_transactions ADD COLUMN IF NOT EXISTS operator_name varchar(50) NULL`,
    );

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_orders_waiter" ON orders (organization_id, waiter_id) WHERE waiter_id IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_orders_created_by_waiter" ON orders (created_by_waiter_id) WHERE created_by_waiter_id IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_payments_processed_by_waiter" ON payments (processed_by_waiter_id) WHERE processed_by_waiter_id IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_refunds_waiter" ON refunds (waiter_id) WHERE waiter_id IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_pfand_returns_waiter" ON pfand_returns (waiter_id) WHERE waiter_id IS NOT NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS waiter_limit int NULL`,
    );

    for (const value of [
      'waiter_created',
      'waiter_updated',
      'waiter_pin_reset',
      'waiter_deleted',
      'waiter_pin_lock',
      'waiter_pin_unlock',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "admin_action" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }

    // Entscheidung 15: „PIN verlangen“ wird zum Modus „Gemeinsame Kasse“.
    await queryRunner.query(`
      UPDATE devices
         SET settings = settings || '{"waiterMode":"shared"}'::jsonb
       WHERE settings->>'requirePin' = 'true'
         AND NOT (settings ? 'waiterMode')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE devices
         SET settings = settings - 'waiterMode' - 'waiterId' - 'autoLockSeconds' - 'lockAfterPayment' - 'waiterTiles' - 'waiterPinLockedAt'
       WHERE settings ? 'waiterMode' OR settings ? 'waiterPinLockedAt'
    `);
    await queryRunner.query(
      `ALTER TABLE organizations DROP COLUMN IF EXISTS waiter_limit`,
    );
    for (const index of [
      'IDX_pfand_returns_waiter',
      'IDX_refunds_waiter',
      'IDX_payments_processed_by_waiter',
      'IDX_orders_created_by_waiter',
      'IDX_orders_waiter',
    ]) {
      await queryRunner.query(`DROP INDEX IF EXISTS "${index}"`);
    }
    const drop = (table: string, column: string) =>
      queryRunner.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS ${column}`);
    await drop('tse_transactions', 'operator_name');
    await drop('tse_transactions', 'waiter_id');
    await drop('cashbook_entries', 'waiter_id');
    await drop('order_events', 'waiter_id');
    await drop('pfand_returns', 'waiter_id');
    await drop('refunds', 'approved_by_user_id');
    await drop('refunds', 'approved_by_waiter_id');
    await drop('refunds', 'waiter_id');
    await drop('payments', 'tip_amount');
    await drop('payments', 'wallet_waiter_id');
    await drop('payments', 'processed_by_waiter_id');
    await drop('order_items', 'added_by_user_id');
    await drop('order_items', 'added_by_waiter_id');
    await drop('orders', 'waiter_id');
    await drop('orders', 'created_by_waiter_id');
    await queryRunner.query(`DROP TABLE IF EXISTS waiter_sessions`);
    await queryRunner.query(`DROP TABLE IF EXISTS pin_credentials`);
    await queryRunner.query(`DROP TABLE IF EXISTS waiters`);
    // Werte im Enum admin_action bleiben (Postgres kann sie nicht entfernen).
  }
}
