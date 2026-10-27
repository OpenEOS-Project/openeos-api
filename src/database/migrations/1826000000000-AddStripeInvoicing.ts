import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kauf auf Rechnung ueber Stripe Invoicing.
 *
 * - `events`: die Stripe-Rechnung zur Freischaltung und ihr Zahlungsstand.
 *   Die Freischaltung (`billing_status = 'invoice'`) gilt sofort; ob
 *   bezahlt ist, steht getrennt in `invoice_status` (Stripes Status:
 *   draft, open, paid, void, uncollectible — "ueberfaellig" wird aus
 *   `invoice_due_at` abgeleitet). Altfaelle (auf Rechnung ohne
 *   Stripe-Rechnung) behalten leere Spalten.
 * - `organizations.invoice_days_until_due`: Zahlungsziel je Organisation,
 *   leer = Standard aus STRIPE_INVOICE_DAYS_UNTIL_DUE.
 * - `event_billing_cancellations`: ob die Stripe-Rechnung storniert (void)
 *   wurde und auf welchem Weg erstattet wird.
 * - `admin_action`: Eintraege fuer das Admin-Protokoll zum Rechnungslauf.
 *
 * Nur Erweiterungen mit leeren bzw. Standardwerten — laufende Instanzen der
 * Vorversion kommen damit zurecht. Enum-Werte lassen sich in PostgreSQL
 * nicht entfernen; down() laesst sie stehen.
 */
export class AddStripeInvoicing1826000000000 implements MigrationInterface {
  name = 'AddStripeInvoicing1826000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE events
        ADD COLUMN IF NOT EXISTS stripe_invoice_id varchar(255) NULL,
        ADD COLUMN IF NOT EXISTS stripe_invoice_number varchar(100) NULL,
        ADD COLUMN IF NOT EXISTS invoice_status varchar(20) NULL,
        ADD COLUMN IF NOT EXISTS invoice_due_at timestamp with time zone NULL,
        ADD COLUMN IF NOT EXISTS invoice_paid_at timestamp with time zone NULL,
        ADD COLUMN IF NOT EXISTS invoice_hosted_url text NULL,
        ADD COLUMN IF NOT EXISTS invoice_pdf_url text NULL
    `);
    await queryRunner.query(`
      ALTER TABLE events
        ADD CONSTRAINT chk_events_invoice_status
        CHECK (invoice_status IS NULL OR invoice_status IN
          ('draft', 'open', 'paid', 'void', 'uncollectible'))
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_events_stripe_invoice_id
        ON events (stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE organizations
        ADD COLUMN IF NOT EXISTS invoice_days_until_due int NULL
    `);
    await queryRunner.query(`
      ALTER TABLE event_billing_cancellations
        ADD COLUMN IF NOT EXISTS invoice_voided boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS refund_via varchar(30) NULL
    `);
    for (const value of [
      'event_invoice_issued',
      'event_invoice_paid',
      'event_invoice_payment_failed',
      'event_invoice_voided',
      'event_invoice_uncollectible',
      'event_invoice_credit_note',
      'event_invoice_resent',
      'event_invoice_marked_paid',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "admin_action" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE event_billing_cancellations
        DROP COLUMN IF EXISTS refund_via,
        DROP COLUMN IF EXISTS invoice_voided
    `);
    await queryRunner.query(`
      ALTER TABLE organizations DROP COLUMN IF EXISTS invoice_days_until_due
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_events_stripe_invoice_id`,
    );
    await queryRunner.query(`
      ALTER TABLE events
        DROP CONSTRAINT IF EXISTS chk_events_invoice_status,
        DROP COLUMN IF EXISTS invoice_pdf_url,
        DROP COLUMN IF EXISTS invoice_hosted_url,
        DROP COLUMN IF EXISTS invoice_paid_at,
        DROP COLUMN IF EXISTS invoice_due_at,
        DROP COLUMN IF EXISTS invoice_status,
        DROP COLUMN IF EXISTS stripe_invoice_number,
        DROP COLUMN IF EXISTS stripe_invoice_id
    `);
  }
}
