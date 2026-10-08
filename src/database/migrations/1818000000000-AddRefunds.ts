import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Erstattungen als eigene Belege (Gegenbelege) und Verlauf je Bestellung.
 *
 * - `refunds`: ein Gegenbeleg mit negativen Betraegen (CHECK), MwSt je Satz
 *   (`tax_lines`), Bezug auf Bestellung und Ursprungszahlung, Rueckgabeweg
 *   (`payment_method`, `provider`, `provider_reference`), Grund, Geraet und
 *   Bediener. Spaetere TSE-Signatur (Release 1.7) haengt sich an diese
 *   Zeile (eigener RECEIPT mit umgekehrten Vorzeichen, Referenz auf den
 *   Ursprungsbeleg).
 * - `refund_items`: Positionen des Gegenbelegs.
 * - `order_events`: Protokoll der Storno-/Erstattungsaktionen und Nachdrucke.
 * - `orders.refunded_amount` (Summe der Erstattungen, fuer Liste/Filter) und
 *   `order_items.refunded_quantity` (Kulanz-Erstattung ohne Storno).
 * - Index fuer den Verlauf „Dieses Geraet“.
 *
 * Alles haengt per ON DELETE CASCADE an der Bestellung — das Loeschen der
 * Testbestellungen beim Aktivieren nimmt die Erstattungen mit.
 *
 * down() entfernt Tabellen, Spalten und Index wieder.
 */
export class AddRefunds1818000000000 implements MigrationInterface {
  name = 'AddRefunds1818000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_amount numeric(10,2) NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS refunded_quantity int NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(`
      CREATE TABLE refunds (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        updated_at timestamp with time zone NOT NULL DEFAULT now(),
        organization_id uuid NOT NULL,
        order_id uuid NOT NULL,
        payment_id uuid NULL,
        event_id uuid NULL,
        refund_number varchar(60) NOT NULL,
        kind varchar(20) NOT NULL,
        amount numeric(10,2) NOT NULL,
        tax_total numeric(10,2) NOT NULL DEFAULT 0,
        pfand_amount numeric(10,2) NOT NULL DEFAULT 0,
        tip_amount numeric(10,2) NOT NULL DEFAULT 0,
        tax_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
        payment_method payment_method NOT NULL,
        status varchar(20) NOT NULL,
        provider varchar(50) NOT NULL,
        provider_reference varchar(255) NULL,
        reason_code varchar(30) NOT NULL,
        reason_text text NULL,
        device_id uuid NULL,
        user_id uuid NULL,
        actor_name varchar(255) NULL,
        is_test boolean NOT NULL DEFAULT false,
        client_request_id uuid NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        CONSTRAINT "CHK_refunds_kind" CHECK (kind IN ('cancellation', 'refund')),
        CONSTRAINT "CHK_refunds_status" CHECK (status IN ('completed', 'manual', 'test')),
        CONSTRAINT "CHK_refunds_amount_negative" CHECK (amount < 0),
        CONSTRAINT "CHK_refunds_parts_not_positive" CHECK (
          tax_total <= 0 AND pfand_amount <= 0 AND tip_amount <= 0
        ),
        CONSTRAINT "FK_refunds_organization" FOREIGN KEY (organization_id)
          REFERENCES organizations(id) ON DELETE CASCADE,
        CONSTRAINT "FK_refunds_order" FOREIGN KEY (order_id)
          REFERENCES orders(id) ON DELETE CASCADE,
        CONSTRAINT "FK_refunds_payment" FOREIGN KEY (payment_id)
          REFERENCES payments(id) ON DELETE SET NULL,
        CONSTRAINT "FK_refunds_event" FOREIGN KEY (event_id)
          REFERENCES events(id) ON DELETE SET NULL,
        CONSTRAINT "FK_refunds_device" FOREIGN KEY (device_id)
          REFERENCES devices(id) ON DELETE SET NULL,
        CONSTRAINT "FK_refunds_user" FOREIGN KEY (user_id)
          REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_refunds_order" ON refunds (order_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_refunds_org_created" ON refunds (organization_id, created_at)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_refunds_payment" ON refunds (payment_id)`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_refunds_org_client_request"
        ON refunds (organization_id, client_request_id)
        WHERE client_request_id IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE refund_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        updated_at timestamp with time zone NOT NULL DEFAULT now(),
        refund_id uuid NOT NULL,
        order_item_id uuid NULL,
        product_name varchar(255) NOT NULL,
        quantity int NOT NULL,
        unit_price numeric(10,2) NOT NULL,
        tax_rate numeric(5,2) NOT NULL DEFAULT 0,
        amount numeric(10,2) NOT NULL,
        deposit_amount numeric(10,2) NOT NULL DEFAULT 0,
        cancelled boolean NOT NULL DEFAULT false,
        CONSTRAINT "CHK_refund_items_quantity" CHECK (quantity > 0),
        CONSTRAINT "CHK_refund_items_amounts" CHECK (amount <= 0 AND deposit_amount <= 0),
        CONSTRAINT "FK_refund_items_refund" FOREIGN KEY (refund_id)
          REFERENCES refunds(id) ON DELETE CASCADE,
        CONSTRAINT "FK_refund_items_order_item" FOREIGN KEY (order_item_id)
          REFERENCES order_items(id) ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_refund_items_refund" ON refund_items (refund_id)`,
    );

    await queryRunner.query(`
      CREATE TABLE order_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        updated_at timestamp with time zone NOT NULL DEFAULT now(),
        organization_id uuid NOT NULL,
        order_id uuid NOT NULL,
        type varchar(40) NOT NULL,
        device_id uuid NULL,
        user_id uuid NULL,
        actor_name varchar(255) NULL,
        data jsonb NOT NULL DEFAULT '{}'::jsonb,
        CONSTRAINT "FK_order_events_organization" FOREIGN KEY (organization_id)
          REFERENCES organizations(id) ON DELETE CASCADE,
        CONSTRAINT "FK_order_events_order" FOREIGN KEY (order_id)
          REFERENCES orders(id) ON DELETE CASCADE,
        CONSTRAINT "FK_order_events_device" FOREIGN KEY (device_id)
          REFERENCES devices(id) ON DELETE SET NULL,
        CONSTRAINT "FK_order_events_user" FOREIGN KEY (user_id)
          REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_order_events_order_created" ON order_events (order_id, created_at)`,
    );

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_orders_org_device_created"
        ON orders (organization_id, created_by_device_id, created_at)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_orders_org_device_created"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS order_events`);
    await queryRunner.query(`DROP TABLE IF EXISTS refund_items`);
    await queryRunner.query(`DROP TABLE IF EXISTS refunds`);
    await queryRunner.query(
      `ALTER TABLE order_items DROP COLUMN IF EXISTS refunded_quantity`,
    );
    await queryRunner.query(
      `ALTER TABLE orders DROP COLUMN IF EXISTS refunded_amount`,
    );
  }
}
