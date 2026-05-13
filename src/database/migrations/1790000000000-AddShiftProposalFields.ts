import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddShiftProposalFields1790000000000 implements MigrationInterface {
  name = 'AddShiftProposalFields1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Admin-initiated 'move-to-different-shift' proposals carry a token-based
    // accept/decline link. The fields live on the registration directly —
    // only one proposal at a time per registration is supported, which fits
    // the workflow (admin proposes, helper accepts or declines, then it's
    // done).
    await queryRunner.query(`
      ALTER TABLE "shift_registrations"
        ADD COLUMN IF NOT EXISTS "proposed_shift_id" uuid NULL,
        ADD COLUMN IF NOT EXISTS "proposed_at" TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS "proposed_message" text NULL,
        ADD COLUMN IF NOT EXISTS "proposed_token" varchar(64) NULL
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_shift_registrations_proposed_shift') THEN
          ALTER TABLE "shift_registrations"
            ADD CONSTRAINT "fk_shift_registrations_proposed_shift"
            FOREIGN KEY ("proposed_shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL;
        END IF;
      END $$
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_shift_registrations_proposed_token"
        ON "shift_registrations" ("proposed_token")
        WHERE "proposed_token" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_shift_registrations_proposed_token"`);
    await queryRunner.query(`ALTER TABLE "shift_registrations" DROP CONSTRAINT IF EXISTS "fk_shift_registrations_proposed_shift"`);
    await queryRunner.query(`
      ALTER TABLE "shift_registrations"
        DROP COLUMN IF EXISTS "proposed_token",
        DROP COLUMN IF EXISTS "proposed_message",
        DROP COLUMN IF EXISTS "proposed_at",
        DROP COLUMN IF EXISTS "proposed_shift_id"
    `);
  }
}
