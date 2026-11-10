import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Digitaler Beleg (QR-Code, E-Mail, PDF) nach der Zahlung.
 *
 * - `receipt_links`: Link auf den Beleg einer oder mehrerer Bestellungen.
 *   Nur der SHA-256 des Tokens wird gespeichert; der Link gilt bis
 *   `expires_at` (Standard 90 Tage, `RECEIPT_LINK_DAYS`) und wird danach
 *   vom Loeschlauf `receipt_links` entfernt. Keine Gaesteangaben.
 * - Index fuer die Versandgrenze je Geraet: Beleg-Mails stehen ohne
 *   Adresse im Verlauf der Bestellung (`order_events`, Typ
 *   `receipt_emailed`).
 */
export class AddReceiptLinks1841900000000 implements MigrationInterface {
  name = 'AddReceiptLinks1841900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS receipt_links (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        token_hash char(64) NOT NULL,
        order_ids uuid[] NOT NULL,
        created_by_device_id uuid NULL,
        created_by_user_id uuid NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_receipt_links_token_hash" UNIQUE (token_hash),
        CONSTRAINT "CHK_receipt_links_orders" CHECK (cardinality(order_ids) BETWEEN 1 AND 20)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_receipt_links_expires" ON receipt_links (expires_at)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_order_events_receipt_mail" ON order_events (device_id, created_at) WHERE type = 'receipt_emailed'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_order_events_receipt_mail"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS receipt_links`);
  }
}
