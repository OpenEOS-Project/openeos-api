import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kellnerabrechnung und Datenschutz der Bedienungen
 * (bedienungen-plan.md §4, §7, §10; Phasen P3 und P4).
 *
 * - `waiter_settlements`: abgeschlossene Abrechnung je Bedienung bzw.
 *   Mitglied und Veranstaltung mit dem Schnappschuss aller Zahlen
 *   (`totals`). Unveraenderlich per Trigger wie `cash_point_closings`:
 *   nur `printed_at` darf sich aendern. Loeschen geht nur fuer
 *   Trainings-Abrechnungen (Testbuchungen, beim Aktivieren mit geloescht)
 *   und wenn die Organisation selbst geloescht wird. Die Nummer zaehlt je
 *   Organisation; Trainings-Abrechnungen haben keine. Die Personen-IDs
 *   sind bewusst ohne Fremdschluessel (Schnappschuss; der Name kommt ueber
 *   die Bedienung und verschwindet mit ihrer Anonymisierung).
 * - `waiters.deactivated_at`: Beginn der Frist „30 Tage nach
 *   Deaktivierung“ (Loeschlauf `waiter_data`).
 * - `waiters.event_id`: ON DELETE SET NULL statt CASCADE. Wird eine
 *   Veranstaltung wirklich geloescht, verschwanden bisher ihre Bedienungen
 *   und mit ihnen (ON DELETE SET NULL) die Zuordnung in Zahlungen,
 *   Erstattungen und Bestellungen. Jetzt bleibt die Bedienung (deaktiviert,
 *   ohne PIN, per Trigger) und wird vom Loeschlauf anonymisiert.
 */
export class AddWaiterSettlements1841500000000 implements MigrationInterface {
  name = 'AddWaiterSettlements1841500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS waiter_settlements (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        number int NULL,
        is_test boolean NOT NULL DEFAULT false,
        waiter_id uuid NULL,
        user_id uuid NULL,
        event_id uuid NULL,
        period_from timestamptz NULL,
        period_to timestamptz NOT NULL,
        totals jsonb NOT NULL DEFAULT '{}',
        opening_float numeric(12,2) NOT NULL DEFAULT 0,
        cash_expected numeric(12,2) NULL,
        cash_counted numeric(12,2) NULL,
        difference numeric(12,2) NULL,
        wallet boolean NOT NULL DEFAULT false,
        open_tables jsonb NOT NULL DEFAULT '[]',
        forced boolean NOT NULL DEFAULT false,
        note varchar(500) NULL,
        settled_by_user_id uuid NULL,
        settled_by_waiter_id uuid NULL,
        device_id uuid NULL,
        cashbook_entry_ids uuid[] NOT NULL DEFAULT '{}',
        printed_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_waiter_settlements_subject" CHECK ((waiter_id IS NULL) <> (user_id IS NULL)),
        CONSTRAINT "CHK_waiter_settlements_number" CHECK (is_test OR number IS NOT NULL),
        CONSTRAINT "CHK_waiter_settlements_forced_note" CHECK (NOT forced OR (note IS NOT NULL AND length(trim(note)) > 0)),
        CONSTRAINT "UQ_waiter_settlements_org_number" UNIQUE (organization_id, number)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_waiter_settlements_org_event" ON waiter_settlements (organization_id, event_id, created_at)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_waiter_settlements_waiter" ON waiter_settlements (waiter_id, event_id, period_to) WHERE waiter_id IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_waiter_settlements_user" ON waiter_settlements (user_id, event_id, period_to) WHERE user_id IS NOT NULL`,
    );

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION waiter_settlements_immutable() RETURNS trigger AS $$
      BEGIN
        -- Organisation wird geloescht (CASCADE): alles darf weg.
        IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = OLD.organization_id) THEN
          IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END IF;
        IF TG_OP = 'DELETE' THEN
          IF OLD.is_test THEN RETURN OLD; END IF;
          RAISE EXCEPTION 'waiter settlements cannot be deleted';
        END IF;
        IF (to_jsonb(NEW) - 'printed_at' - 'updated_at')
           IS DISTINCT FROM (to_jsonb(OLD) - 'printed_at' - 'updated_at') THEN
          RAISE EXCEPTION 'waiter settlements are immutable';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS waiter_settlements_immutable ON waiter_settlements`,
    );
    await queryRunner.query(`
      CREATE TRIGGER waiter_settlements_immutable
        BEFORE UPDATE OR DELETE ON waiter_settlements
        FOR EACH ROW EXECUTE FUNCTION waiter_settlements_immutable()
    `);

    await queryRunner.query(
      `ALTER TABLE waiters ADD COLUMN IF NOT EXISTS deactivated_at timestamptz NULL`,
    );
    await queryRunner.query(
      `UPDATE waiters SET deactivated_at = updated_at WHERE is_active = false AND deactivated_at IS NULL`,
    );

    // Veranstaltung wirklich geloescht: Bedienungen bleiben (Zuordnung der
    // Buchungen), werden deaktiviert und verlieren ihre PIN.
    await queryRunner.query(`
      DO $$
      DECLARE fk text;
      BEGIN
        SELECT con.conname INTO fk
          FROM pg_constraint con
          JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
         WHERE con.conrelid = 'waiters'::regclass AND con.contype = 'f'
           AND att.attname = 'event_id';
        IF fk IS NOT NULL THEN
          EXECUTE format('ALTER TABLE waiters DROP CONSTRAINT %I', fk);
        END IF;
      END $$
    `);
    await queryRunner.query(
      `ALTER TABLE waiters ADD CONSTRAINT "FK_waiters_event" FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL`,
    );
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION waiters_retire_on_event_delete() RETURNS trigger AS $$
      BEGIN
        -- Organisation wird geloescht (CASCADE): Bedienungen gehen mit.
        IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = OLD.organization_id) THEN
          RETURN OLD;
        END IF;
        UPDATE waiter_sessions SET ended_at = now(), end_reason = 'revoked'
         WHERE ended_at IS NULL
           AND waiter_id IN (SELECT id FROM waiters WHERE event_id = OLD.id);
        DELETE FROM pin_credentials
         WHERE owner_type = 'waiter'
           AND owner_id IN (SELECT id FROM waiters WHERE event_id = OLD.id);
        UPDATE waiters
           SET is_active = false,
               deactivated_at = COALESCE(deactivated_at, now())
         WHERE event_id = OLD.id;
        RETURN OLD;
      END
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS waiters_retire_on_event_delete ON events`,
    );
    await queryRunner.query(`
      CREATE TRIGGER waiters_retire_on_event_delete
        BEFORE DELETE ON events
        FOR EACH ROW EXECUTE FUNCTION waiters_retire_on_event_delete()
    `);

    for (const value of ['waiter_settled', 'waiter_tables_transferred']) {
      await queryRunner.query(
        `ALTER TYPE "admin_action" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS waiters_retire_on_event_delete ON events`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS waiters_retire_on_event_delete()`,
    );
    await queryRunner.query(
      `ALTER TABLE waiters DROP CONSTRAINT IF EXISTS "FK_waiters_event"`,
    );
    await queryRunner.query(
      `ALTER TABLE waiters ADD CONSTRAINT "FK_waiters_event" FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE waiters DROP COLUMN IF EXISTS deactivated_at`,
    );
    // Abrechnungen bleiben, solange es welche gibt (wie Kassenabschluesse).
    const rows: { n: number }[] = (await queryRunner.query(
      `SELECT count(*)::int AS n FROM waiter_settlements WHERE NOT is_test`,
    )) as { n: number }[];
    const n = rows[0]?.n ?? 0;
    if (n === 0) {
      await queryRunner.query(`DROP TABLE IF EXISTS waiter_settlements`);
      await queryRunner.query(
        `DROP FUNCTION IF EXISTS waiter_settlements_immutable()`,
      );
    }
  }
}
