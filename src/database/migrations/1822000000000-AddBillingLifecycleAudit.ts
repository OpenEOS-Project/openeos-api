import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Abgelaufene Checkouts, Rueckbuchungen und Kulanz durch die Plattform.
 *
 * - `admin_action`: neue Eintraege fuer das Admin-Protokoll.
 * - `admin_audit_logs.admin_user_id` darf leer sein: Stripe-Webhooks und der
 *   Aufraeumjob protokollieren ohne angemeldeten Admin.
 * - `event_billing_cancellations.kind`/`reason`: eine Zeile ist entweder ein
 *   Storno (Freischaltung aufgehoben) oder eine Kulanzerstattung
 *   (Freischaltung bleibt); die Plattform muss begruenden.
 *
 * Nur Erweiterungen — laufende Instanzen der Vorversion kommen damit
 * zurecht (neue Spalten haben einen Standardwert bzw. sind optional).
 *
 * down() entfernt die Spalten und die Systemeintraege; Enum-Werte lassen
 * sich in PostgreSQL nicht entfernen.
 */
export class AddBillingLifecycleAudit1822000000000 implements MigrationInterface {
  name = 'AddBillingLifecycleAudit1822000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const value of [
      'event_checkout_released',
      'event_billing_cancelled',
      'event_billing_goodwill_refund',
      'event_payment_dispute_opened',
      'event_payment_dispute_closed',
      'event_duplicate_payment',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "admin_action" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE admin_audit_logs ALTER COLUMN admin_user_id DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE event_billing_cancellations
         ADD COLUMN IF NOT EXISTS kind varchar(20) NOT NULL DEFAULT 'cancellation',
         ADD COLUMN IF NOT EXISTS reason text NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE event_billing_cancellations
         ADD CONSTRAINT chk_event_billing_cancellations_kind
         CHECK (kind IN ('cancellation', 'goodwill'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE event_billing_cancellations
         DROP CONSTRAINT IF EXISTS chk_event_billing_cancellations_kind,
         DROP COLUMN IF EXISTS reason,
         DROP COLUMN IF EXISTS kind`,
    );
    await queryRunner.query(
      `DELETE FROM admin_audit_logs WHERE admin_user_id IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE admin_audit_logs ALTER COLUMN admin_user_id SET NOT NULL`,
    );
  }
}
