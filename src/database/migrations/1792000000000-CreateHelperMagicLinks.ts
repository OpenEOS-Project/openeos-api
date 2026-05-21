import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateHelperMagicLinks1792000000000 implements MigrationInterface {
  name = 'CreateHelperMagicLinks1792000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Lightweight token store for the helper-side self-service flow: the
    // helper enters their email on the public plan page, we issue a 24h
    // token, mail them a link that bypasses login and lets them view /
    // edit their own shifts in this plan only.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "helper_magic_links" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "token" varchar(64) NOT NULL,
        "shift_plan_id" uuid NOT NULL,
        "email" varchar(255) NOT NULL,
        "expires_at" TIMESTAMPTZ NOT NULL,
        "used_at" TIMESTAMPTZ NULL,
        CONSTRAINT "fk_helper_magic_links_plan"
          FOREIGN KEY ("shift_plan_id") REFERENCES "shift_plans"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_helper_magic_links_token" ON "helper_magic_links" ("token")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_helper_magic_links_email_plan" ON "helper_magic_links" ("email", "shift_plan_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "helper_magic_links"`);
  }
}
