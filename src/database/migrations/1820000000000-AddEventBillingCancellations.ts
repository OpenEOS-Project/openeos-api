import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kostenloser Storno einer Freischaltung bis 7 Tage vor Beginn.
 *
 * - `events.unlocked_start_date`: der Beginn, wie er beim Freischalten
 *   stand. Die Stornofrist rechnet vom frueheren der beiden Zeitpunkte
 *   (damals, jetzt) — sonst liesse sich die Frist durch Verschieben nach
 *   hinten beliebig verlaengern. Bestehende bezahlte bzw. bestellte
 *   Veranstaltungen bekommen ihren heutigen Beginn; den damaligen kennt
 *   niemand mehr.
 * - `event_billing_cancellations`: je Stornierung eine Zeile mit Betrag,
 *   Stripe-Erstattung, Stornorechnung und wer storniert hat.
 *
 * down() entfernt Tabelle und Spalte wieder.
 */
export class AddEventBillingCancellations1820000000000 implements MigrationInterface {
  name = 'AddEventBillingCancellations1820000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE events ADD COLUMN IF NOT EXISTS unlocked_start_date timestamp with time zone NULL`,
    );
    await queryRunner.query(
      `UPDATE events SET unlocked_start_date = start_date
         WHERE billing_status IN ('paid', 'invoice') AND unlocked_start_date IS NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE event_billing_cancellations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        updated_at timestamp with time zone NOT NULL DEFAULT now(),
        event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        organization_id uuid NOT NULL,
        cancelled_by uuid NULL,
        initiated_by varchar(20) NOT NULL,
        previous_billing_status varchar(20) NOT NULL,
        amount numeric(10,2) NOT NULL,
        currency varchar(3) NOT NULL DEFAULT 'EUR',
        paid_at timestamp with time zone NULL,
        billed_days int NULL,
        deadline timestamp with time zone NULL,
        stripe_checkout_session_id varchar(255) NULL,
        stripe_payment_intent_id varchar(255) NULL,
        stripe_invoice_id varchar(255) NULL,
        stripe_refund_id varchar(255) NULL,
        refund_status varchar(20) NULL,
        stripe_credit_note_id varchar(255) NULL,
        credit_note_number varchar(100) NULL,
        manual_credit_note_required boolean NOT NULL DEFAULT false,
        invoiced_at timestamp with time zone NULL,
        invoice_note text NULL,
        CONSTRAINT chk_event_billing_cancellations_initiated_by
          CHECK (initiated_by IN ('organization', 'platform')),
        CONSTRAINT chk_event_billing_cancellations_previous_status
          CHECK (previous_billing_status IN ('paid', 'invoice'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_event_billing_cancellations_event ON event_billing_cancellations (event_id, created_at)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_event_billing_cancellations_org ON event_billing_cancellations (organization_id, created_at)`,
    );
    /* Eine Stripe-Erstattung gehoert zu genau einer Stornierung — der
       Webhook findet die Zeile darueber, und ein doppelt verbuchter Storno
       scheitert hier statt still eine zweite Zeile anzulegen. */
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_event_billing_cancellations_refund ON event_billing_cancellations (stripe_refund_id) WHERE stripe_refund_id IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS event_billing_cancellations`);
    await queryRunner.query(
      `ALTER TABLE events DROP COLUMN IF EXISTS unlocked_start_date`,
    );
  }
}
