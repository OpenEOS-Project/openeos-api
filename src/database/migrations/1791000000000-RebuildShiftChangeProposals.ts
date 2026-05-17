import { MigrationInterface, QueryRunner } from 'typeorm';

export class RebuildShiftChangeProposals1791000000000 implements MigrationInterface {
  name = 'RebuildShiftChangeProposals1791000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Replace the single-shift propose fields (added in 1790000000000) with a
    // proper proposal table that supports an arbitrary list of add+remove ops
    // — the admin now edits the helper's whole group in one go and may want
    // to propose multiple changes at once.
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_shift_registrations_proposed_token"`);
    await queryRunner.query(`ALTER TABLE "shift_registrations" DROP CONSTRAINT IF EXISTS "fk_shift_registrations_proposed_shift"`);
    await queryRunner.query(`
      ALTER TABLE "shift_registrations"
        DROP COLUMN IF EXISTS "proposed_token",
        DROP COLUMN IF EXISTS "proposed_message",
        DROP COLUMN IF EXISTS "proposed_at",
        DROP COLUMN IF EXISTS "proposed_shift_id"
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'shift_change_proposal_status') THEN
          CREATE TYPE "shift_change_proposal_status" AS ENUM ('pending', 'accepted', 'declined', 'expired');
        END IF;
      END $$
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "shift_change_proposals" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "organization_id" uuid NOT NULL,
        "shift_plan_id" uuid NOT NULL,
        "registration_group_id" uuid NOT NULL,
        "token" varchar(64) NOT NULL,
        "ops" jsonb NOT NULL,
        "message" text,
        "status" "shift_change_proposal_status" NOT NULL DEFAULT 'pending',
        "responded_at" TIMESTAMPTZ NULL,
        CONSTRAINT "fk_shift_change_proposals_organization"
          FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_shift_change_proposals_plan"
          FOREIGN KEY ("shift_plan_id") REFERENCES "shift_plans"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_shift_change_proposals_token" ON "shift_change_proposals" ("token")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_shift_change_proposals_group" ON "shift_change_proposals" ("registration_group_id", "status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "shift_change_proposals"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "shift_change_proposal_status"`);
    await queryRunner.query(`
      ALTER TABLE "shift_registrations"
        ADD COLUMN IF NOT EXISTS "proposed_shift_id" uuid NULL,
        ADD COLUMN IF NOT EXISTS "proposed_at" TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS "proposed_message" text NULL,
        ADD COLUMN IF NOT EXISTS "proposed_token" varchar(64) NULL
    `);
  }
}
