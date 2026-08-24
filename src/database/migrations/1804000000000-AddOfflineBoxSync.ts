import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Schema for offline box sync (docs/design/offline-box-sync.md, step 1 of
 * the build order). Adds:
 *   - RentalHardwareType values for local_server/tablet/phone/router
 *   - RentalAssignment.syncStatus / syncToken
 *   - a unique-active-assignment-per-event constraint
 *   - sync provenance columns + soft-delete on orders/order_items/
 *     payments/print_jobs
 *   - sync_version_seq, sync_outbox (box-side), sync_inbox (central-side)
 *
 * No data migration needed: all new columns are nullable or defaulted, and
 * existing rows simply have origin_node/sync_version/synced_at = null,
 * meaning "predates sync / not part of the sync system".
 */
export class AddOfflineBoxSync1804000000000 implements MigrationInterface {
  name = 'AddOfflineBoxSync1804000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- RentalHardwareType additions ---------------------------------
    // Postgres 12+ allows ADD VALUE inside a transaction as long as the new
    // value isn't used in the same transaction, which it isn't here.
    await queryRunner.query(
      `ALTER TYPE "rental_hardware_type" ADD VALUE IF NOT EXISTS 'local_server'`,
    );
    await queryRunner.query(
      `ALTER TYPE "rental_hardware_type" ADD VALUE IF NOT EXISTS 'tablet'`,
    );
    await queryRunner.query(
      `ALTER TYPE "rental_hardware_type" ADD VALUE IF NOT EXISTS 'phone'`,
    );
    await queryRunner.query(
      `ALTER TYPE "rental_hardware_type" ADD VALUE IF NOT EXISTS 'router'`,
    );

    // --- RentalAssignment sync fields ----------------------------------
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "rental_sync_status" AS ENUM (
          'not_provisioned', 'provisioning', 'active', 'syncing', 'synced', 'error'
        );
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
    await queryRunner.query(`
      ALTER TABLE "rental_assignments"
        ADD COLUMN IF NOT EXISTS "sync_status" "rental_sync_status" NOT NULL DEFAULT 'not_provisioned'
    `);
    await queryRunner.query(`
      ALTER TABLE "rental_assignments"
        ADD COLUMN IF NOT EXISTS "sync_token" character varying(255)
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "rental_assignments" ADD CONSTRAINT "UQ_rental_assignments_sync_token" UNIQUE ("sync_token");
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    // One active box per event — turns a scheduling mistake into a
    // rejected write instead of two writers silently racing (design doc §2.5).
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_rental_assignments_one_active_per_event"
        ON "rental_assignments" ("event_id")
        WHERE "status" = 'active'
    `);

    // --- Sync provenance + soft-delete on syncable entities ------------
    for (const table of ['orders', 'order_items', 'payments', 'print_jobs']) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP WITH TIME ZONE,
          ADD COLUMN IF NOT EXISTS "origin_node" character varying(255),
          ADD COLUMN IF NOT EXISTS "sync_version" bigint,
          ADD COLUMN IF NOT EXISTS "synced_at" TIMESTAMP WITH TIME ZONE
      `);
    }

    // Shared monotonic source for sync_version. Deliberately a plain
    // sequence, not a timestamp — see design doc §6 (clock drift on an
    // offline box).
    await queryRunner.query(`CREATE SEQUENCE IF NOT EXISTS "sync_version_seq"`);

    // --- sync_outbox (box-side pending-push queue) ----------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sync_outbox" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "entity_type" character varying(100) NOT NULL,
        "entity_id" uuid NOT NULL,
        "sync_version" bigint NOT NULL,
        "payload" jsonb NOT NULL,
        "pushed_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_sync_outbox" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sync_outbox_pushed_at_sync_version"
        ON "sync_outbox" ("pushed_at", "sync_version")
    `);

    // --- sync_inbox (central-side idempotent receipt log) ---------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sync_inbox" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "assignment_id" uuid NOT NULL,
        "entity_type" character varying(100) NOT NULL,
        "entity_id" uuid NOT NULL,
        "sync_version" bigint NOT NULL,
        "payload" jsonb NOT NULL,
        "received_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_sync_inbox" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_sync_inbox_entity_version" UNIQUE ("entity_type", "entity_id", "sync_version"),
        CONSTRAINT "FK_sync_inbox_assignment" FOREIGN KEY ("assignment_id")
          REFERENCES "rental_assignments"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sync_inbox_assignment_received"
        ON "sync_inbox" ("assignment_id", "received_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "sync_inbox"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sync_outbox"`);
    await queryRunner.query(`DROP SEQUENCE IF EXISTS "sync_version_seq"`);

    for (const table of ['orders', 'order_items', 'payments', 'print_jobs']) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          DROP COLUMN IF EXISTS "deleted_at",
          DROP COLUMN IF EXISTS "origin_node",
          DROP COLUMN IF EXISTS "sync_version",
          DROP COLUMN IF EXISTS "synced_at"
      `);
    }

    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_rental_assignments_one_active_per_event"`,
    );
    await queryRunner.query(`
      ALTER TABLE "rental_assignments" DROP CONSTRAINT IF EXISTS "UQ_rental_assignments_sync_token"
    `);
    await queryRunner.query(
      `ALTER TABLE "rental_assignments" DROP COLUMN IF EXISTS "sync_token"`,
    );
    await queryRunner.query(
      `ALTER TABLE "rental_assignments" DROP COLUMN IF EXISTS "sync_status"`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS "rental_sync_status"`);

    // Not reverting the rental_hardware_type ADD VALUEs: Postgres has no
    // ALTER TYPE ... DROP VALUE, and any rows already using
    // local_server/tablet/phone/router would block a type rebuild anyway.
  }
}
