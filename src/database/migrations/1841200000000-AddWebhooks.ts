import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ausgehende Webhooks (AGB Ziffer 10.2): Endpunkte je Organisation,
 * Zustellungen mit Protokoll und ein Postausgang (`webhook_outbox`).
 *
 * Den Postausgang fuellen Trigger auf den Fachtabellen — Bestellungen,
 * Zahlungen, Erstattungen, Pfandrueckgaben, Kassenabschluesse,
 * Veranstaltungen, Produkte. So erfasst jede Stelle im Code, die eine
 * Bestellung anlegt oder kassiert, das Ereignis, ohne davon zu wissen, und
 * nur, was wirklich festgeschrieben wurde (ein Rollback nimmt den Eintrag
 * mit). Die Trigger schreiben nur, wenn die Organisation einen aktiven
 * Endpunkt hat (ein Index-Zugriff), und ein Fehler beim Schreiben wird
 * abgefangen (RAISE WARNING): ein Webhook darf nie einen Verkauf verhindern.
 *
 * Den Rest — welche Endpunkte, welcher Inhalt — entscheidet die API beim
 * Abholen (WebhookDispatcherService). Nur expand: alte Instanzen laufen mit
 * dem neuen Schema weiter.
 */
export class AddWebhooks1841200000000 implements MigrationInterface {
  name = 'AddWebhooks1841200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS webhook_endpoints (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        url varchar(2048) NOT NULL,
        description varchar(255) NULL,
        event_types jsonb NOT NULL DEFAULT '[]'::jsonb,
        active boolean NOT NULL DEFAULT true,
        include_guest_data boolean NOT NULL DEFAULT false,
        include_test_orders boolean NOT NULL DEFAULT false,
        secret_encrypted text NOT NULL,
        secret_hint varchar(16) NOT NULL,
        previous_secret_encrypted text NULL,
        previous_secret_expires_at timestamp with time zone NULL,
        consecutive_failures int NOT NULL DEFAULT 0,
        failing_since timestamp with time zone NULL,
        disabled_reason varchar(40) NULL,
        disabled_at timestamp with time zone NULL,
        last_delivery_at timestamp with time zone NULL,
        last_delivery_status varchar(20) NULL,
        last_success_at timestamp with time zone NULL,
        created_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        updated_at timestamp with time zone NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_org ON webhook_endpoints (organization_id)`,
    );
    // Die Trigger fragen genau das: hat die Organisation einen aktiven Endpunkt?
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_org_active ON webhook_endpoints (organization_id) WHERE active`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
        organization_id uuid NOT NULL,
        event_id uuid NOT NULL,
        event_type varchar(60) NOT NULL,
        payload text NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'pending',
        attempts int NOT NULL DEFAULT 0,
        next_attempt_at timestamp with time zone NULL,
        locked_until timestamp with time zone NULL,
        last_attempt_at timestamp with time zone NULL,
        response_status int NULL,
        response_body text NULL,
        duration_ms int NULL,
        error varchar(40) NULL,
        attempt_log jsonb NOT NULL DEFAULT '[]'::jsonb,
        manual boolean NOT NULL DEFAULT false,
        redelivery_of uuid NULL,
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        updated_at timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT chk_webhook_deliveries_status
          CHECK (status IN ('pending', 'delivering', 'succeeded', 'failed'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint ON webhook_deliveries (endpoint_id, created_at DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries (next_attempt_at) WHERE status IN ('pending', 'delivering')`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created ON webhook_deliveries (created_at)`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS webhook_outbox (
        id bigserial PRIMARY KEY,
        organization_id uuid NOT NULL,
        event_type varchar(60) NOT NULL,
        resource_id uuid NOT NULL,
        data jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()
      )
    `);

    /* Letzte gemeldete Phase je Veranstaltung (event.phase_changed): die
       Phase wird nicht gespeichert, sondern abgeleitet — wer sie meldet,
       muss sich merken, was er zuletzt gesehen hat. */
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS webhook_event_phases (
        event_id uuid PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
        organization_id uuid NOT NULL,
        phase varchar(20) NOT NULL,
        updated_at timestamp with time zone NOT NULL DEFAULT now()
      )
    `);

    // Hilfsfunktion: ein Eintrag, nur bei aktivem Endpunkt, nie mit Fehler.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION webhook_enqueue(
        p_org uuid, p_type text, p_resource uuid, p_data jsonb DEFAULT '{}'::jsonb
      ) RETURNS void AS $$
      BEGIN
        IF p_org IS NULL THEN
          RETURN;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM webhook_endpoints
           WHERE organization_id = p_org AND active
        ) THEN
          RETURN;
        END IF;
        BEGIN
          INSERT INTO webhook_outbox (organization_id, event_type, resource_id, data)
               VALUES (p_org, p_type, p_resource, COALESCE(p_data, '{}'::jsonb));
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'webhook_enqueue % failed: %', p_type, SQLERRM;
        END;
      END
      $$ LANGUAGE plpgsql
    `);

    /* Schnelle Vorpruefung ohne Unterblock: hat die Organisation einen
       aktiven Endpunkt? Nur dann laeuft der eigentliche Teil — in einem
       Block mit EXCEPTION, damit ein Fehler hier nie die Buchung abbricht. */
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION webhook_org_active(p_org uuid) RETURNS boolean AS $$
        SELECT p_org IS NOT NULL AND EXISTS (
          SELECT 1 FROM webhook_endpoints WHERE organization_id = p_org AND active)
      $$ LANGUAGE sql STABLE
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION webhook_capture_order() RETURNS trigger AS $$
      BEGIN
        IF NOT webhook_org_active(NEW.organization_id) THEN
          RETURN NULL;
        END IF;
        BEGIN
          IF TG_OP = 'INSERT' THEN
            PERFORM webhook_enqueue(NEW.organization_id, 'order.created', NEW.id);
            IF NEW.source::text = 'online' THEN
              PERFORM webhook_enqueue(NEW.organization_id, 'shop.order.created', NEW.id);
            END IF;
            IF NEW.payment_status::text = 'paid' THEN
              PERFORM webhook_enqueue(NEW.organization_id, 'order.paid', NEW.id);
            END IF;
            IF NEW.status::text = 'completed' THEN
              PERFORM webhook_enqueue(NEW.organization_id, 'order.completed', NEW.id);
            ELSIF NEW.status::text = 'cancelled' THEN
              PERFORM webhook_enqueue(NEW.organization_id, 'order.cancelled', NEW.id);
            END IF;
          ELSE
            IF NEW.payment_status::text = 'paid'
               AND OLD.payment_status::text IS DISTINCT FROM 'paid' THEN
              PERFORM webhook_enqueue(NEW.organization_id, 'order.paid', NEW.id);
            END IF;
            IF NEW.status::text = 'completed'
               AND OLD.status::text IS DISTINCT FROM 'completed' THEN
              PERFORM webhook_enqueue(NEW.organization_id, 'order.completed', NEW.id);
            ELSIF NEW.status::text = 'cancelled'
               AND OLD.status::text IS DISTINCT FROM 'cancelled' THEN
              PERFORM webhook_enqueue(NEW.organization_id, 'order.cancelled', NEW.id);
            END IF;
          END IF;
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'webhook capture on % failed: %', TG_TABLE_NAME, SQLERRM;
        END;
        RETURN NULL;
      END
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`DROP TRIGGER IF EXISTS webhook_orders ON orders`);
    await queryRunner.query(`
      CREATE TRIGGER webhook_orders
        AFTER INSERT OR UPDATE OF status, payment_status ON orders
        FOR EACH ROW EXECUTE FUNCTION webhook_capture_order()
    `);

    // Zahlungen tragen keine Organisation — die steht an der Bestellung.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION webhook_capture_payment() RETURNS trigger AS $$
      DECLARE
        v_org uuid;
      BEGIN
        IF NEW.status::text <> 'captured' THEN
          RETURN NULL;
        END IF;
        IF TG_OP = 'UPDATE' AND OLD.status::text = 'captured' THEN
          RETURN NULL;
        END IF;
        SELECT organization_id INTO v_org FROM orders WHERE id = NEW.order_id;
        IF NOT webhook_org_active(v_org) THEN
          RETURN NULL;
        END IF;
        BEGIN
          PERFORM webhook_enqueue(v_org, 'payment.created', NEW.id);
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'webhook capture on % failed: %', TG_TABLE_NAME, SQLERRM;
        END;
        RETURN NULL;
      END
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS webhook_payments ON payments`,
    );
    await queryRunner.query(`
      CREATE TRIGGER webhook_payments
        AFTER INSERT OR UPDATE OF status ON payments
        FOR EACH ROW EXECUTE FUNCTION webhook_capture_payment()
    `);

    // Erstattungen, Pfandrueckgaben, Kassenabschluesse: jeweils beim Anlegen.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION webhook_capture_insert() RETURNS trigger AS $$
      BEGIN
        IF NOT webhook_org_active(NEW.organization_id) THEN
          RETURN NULL;
        END IF;
        BEGIN
          PERFORM webhook_enqueue(NEW.organization_id, TG_ARGV[0], NEW.id);
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'webhook capture on % failed: %', TG_TABLE_NAME, SQLERRM;
        END;
        RETURN NULL;
      END
      $$ LANGUAGE plpgsql
    `);
    for (const [table, type] of [
      ['refunds', 'refund.created'],
      ['pfand_returns', 'pfand_return.created'],
      ['cash_point_closings', 'cash_point_closing.created'],
    ] as const) {
      await queryRunner.query(
        `DROP TRIGGER IF EXISTS webhook_${table} ON ${table}`,
      );
      await queryRunner.query(`
        CREATE TRIGGER webhook_${table}
          AFTER INSERT ON ${table}
          FOR EACH ROW EXECUTE FUNCTION webhook_capture_insert('${type}')
      `);
    }

    // Veranstaltung aktiviert (nach der Freischaltung bzw. im eigenen Betrieb).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION webhook_capture_event() RETURNS trigger AS $$
      BEGIN
        IF NEW.status::text <> 'active'
           OR OLD.status::text = 'active'
           OR NEW.deleted_at IS NOT NULL
           OR NOT webhook_org_active(NEW.organization_id) THEN
          RETURN NULL;
        END IF;
        BEGIN
          PERFORM webhook_enqueue(NEW.organization_id, 'event.activated', NEW.id);
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'webhook capture on % failed: %', TG_TABLE_NAME, SQLERRM;
        END;
        RETURN NULL;
      END
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`DROP TRIGGER IF EXISTS webhook_events ON events`);
    await queryRunner.query(`
      CREATE TRIGGER webhook_events
        AFTER UPDATE OF status ON events
        FOR EACH ROW EXECUTE FUNCTION webhook_capture_event()
    `);

    /* Produkte: nur Stammdaten. Der Bestand sinkt mit jedem Verkauf —
       darauf reagiert der Trigger nicht (stock_quantity fehlt in der Liste). */
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION webhook_capture_product() RETURNS trigger AS $$
      DECLARE
        v_changed text[] := ARRAY[]::text[];
        v_org uuid;
      BEGIN
        SELECT organization_id INTO v_org FROM events WHERE id = NEW.event_id;
        IF NOT webhook_org_active(v_org) THEN
          RETURN NULL;
        END IF;
        BEGIN
          IF NEW.name IS DISTINCT FROM OLD.name THEN v_changed := array_append(v_changed, 'name'); END IF;
          IF NEW.description IS DISTINCT FROM OLD.description THEN v_changed := array_append(v_changed, 'description'); END IF;
          IF NEW.price IS DISTINCT FROM OLD.price THEN v_changed := array_append(v_changed, 'price'); END IF;
          IF NEW.tax_rate IS DISTINCT FROM OLD.tax_rate THEN v_changed := array_append(v_changed, 'taxRate'); END IF;
          IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN v_changed := array_append(v_changed, 'isActive'); END IF;
          IF NEW.is_available IS DISTINCT FROM OLD.is_available THEN v_changed := array_append(v_changed, 'isAvailable'); END IF;
          IF NEW.category_id IS DISTINCT FROM OLD.category_id THEN v_changed := array_append(v_changed, 'categoryId'); END IF;
          IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN v_changed := array_append(v_changed, 'deleted'); END IF;
          IF cardinality(v_changed) > 0 THEN
            PERFORM webhook_enqueue(v_org, 'product.updated', NEW.id,
              jsonb_build_object('changed', to_jsonb(v_changed)));
          END IF;
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'webhook capture on % failed: %', TG_TABLE_NAME, SQLERRM;
        END;
        RETURN NULL;
      END
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS webhook_products ON products`,
    );
    await queryRunner.query(`
      CREATE TRIGGER webhook_products
        AFTER UPDATE OF name, description, price, tax_rate, is_active, is_available, category_id, deleted_at
        ON products
        FOR EACH ROW EXECUTE FUNCTION webhook_capture_product()
    `);

    // Protokoll-Aktionen (Enum-Werte ausserhalb der Transaktion, wie in AddCloudTse).
    await queryRunner.commitTransaction();
    for (const value of [
      'webhook_created',
      'webhook_updated',
      'webhook_deleted',
      'webhook_secret_rotated',
      'webhook_auto_disabled',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "admin_action" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
    await queryRunner.startTransaction();
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [trigger, table] of [
      ['webhook_orders', 'orders'],
      ['webhook_payments', 'payments'],
      ['webhook_refunds', 'refunds'],
      ['webhook_pfand_returns', 'pfand_returns'],
      ['webhook_cash_point_closings', 'cash_point_closings'],
      ['webhook_events', 'events'],
      ['webhook_products', 'products'],
    ]) {
      await queryRunner.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
    }
    for (const fn of [
      'webhook_capture_order()',
      'webhook_capture_payment()',
      'webhook_capture_insert()',
      'webhook_capture_event()',
      'webhook_capture_product()',
      'webhook_enqueue(uuid, text, uuid, jsonb)',
      'webhook_org_active(uuid)',
    ]) {
      await queryRunner.query(`DROP FUNCTION IF EXISTS ${fn}`);
    }
    await queryRunner.query(`DROP TABLE IF EXISTS webhook_event_phases`);
    await queryRunner.query(`DROP TABLE IF EXISTS webhook_outbox`);
    await queryRunner.query(`DROP TABLE IF EXISTS webhook_deliveries`);
    await queryRunner.query(`DROP TABLE IF EXISTS webhook_endpoints`);
    // Enum-Werte bleiben (Postgres kann sie nicht entfernen).
  }
}
