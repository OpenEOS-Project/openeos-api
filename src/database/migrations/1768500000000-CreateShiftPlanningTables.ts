import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateShiftPlanningTables1768500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create shift_plan_status enum
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "shift_plan_status" AS ENUM ('draft', 'published', 'closed');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    // Create shift_registration_status enum
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "shift_registration_status" AS ENUM ('pending_email', 'pending_approval', 'confirmed', 'rejected', 'cancelled');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    // Create shift_plans table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "shift_plans" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "organization_id" uuid NOT NULL,
        "event_id" uuid NULL,
        "name" varchar(255) NOT NULL,
        "description" text NULL,
        "public_slug" varchar(100) NOT NULL,
        "status" "shift_plan_status" NOT NULL DEFAULT 'draft',
        "settings" jsonb NOT NULL DEFAULT '{"requireApproval": true, "allowMultipleShifts": true, "reminderDaysBefore": 1}',
        "created_at" timestamp with time zone NOT NULL DEFAULT now(),
        "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT "FK_shift_plans_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_shift_plans_event" FOREIGN KEY ("event_id")
          REFERENCES "events"("id") ON DELETE SET NULL
      )
    `);

    // Create indexes for shift_plans
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_shift_plans_organization_created"
      ON "shift_plans" ("organization_id", "created_at")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_shift_plans_public_slug"
      ON "shift_plans" ("public_slug")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_shift_plans_status"
      ON "shift_plans" ("status")
    `);

    // Create shift_jobs table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "shift_jobs" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "shift_plan_id" uuid NOT NULL,
        "name" varchar(100) NOT NULL,
        "description" text NULL,
        "color" varchar(7) NULL,
        "sort_order" int NOT NULL DEFAULT 0,
        "created_at" timestamp with time zone NOT NULL DEFAULT now(),
        "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT "FK_shift_jobs_plan" FOREIGN KEY ("shift_plan_id")
          REFERENCES "shift_plans"("id") ON DELETE CASCADE
      )
    `);

    // Create index for shift_jobs
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_shift_jobs_plan_order"
      ON "shift_jobs" ("shift_plan_id", "sort_order")
    `);

    // Create shifts table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "shifts" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "shift_job_id" uuid NOT NULL,
        "date" date NOT NULL,
        "start_time" time NOT NULL,
        "end_time" time NOT NULL,
        "required_workers" int NOT NULL DEFAULT 1,
        "notes" text NULL,
        "created_at" timestamp with time zone NOT NULL DEFAULT now(),
        "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT "FK_shifts_job" FOREIGN KEY ("shift_job_id")
          REFERENCES "shift_jobs"("id") ON DELETE CASCADE
      )
    `);

    // Create indexes for shifts
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_shifts_job_date"
      ON "shifts" ("shift_job_id", "date")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_shifts_date"
      ON "shifts" ("date")
    `);

    // Create shift_registrations table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "shift_registrations" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "shift_id" uuid NOT NULL,
        "registration_group_id" uuid NOT NULL,
        "name" varchar(255) NOT NULL,
        "email" varchar(255) NOT NULL,
        "phone" varchar(50) NULL,
        "notes" text NULL,
        "status" "shift_registration_status" NOT NULL DEFAULT 'pending_email',
        "email_verified_at" timestamp with time zone NULL,
        "verification_token" varchar(64) NOT NULL,
        "admin_notes" text NULL,
        "created_at" timestamp with time zone NOT NULL DEFAULT now(),
        "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT "FK_shift_registrations_shift" FOREIGN KEY ("shift_id")
          REFERENCES "shifts"("id") ON DELETE CASCADE
      )
    `);

    // Create indexes for shift_registrations
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_shift_registrations_shift_status"
      ON "shift_registrations" ("shift_id", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_shift_registrations_email"
      ON "shift_registrations" ("email")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_shift_registrations_token"
      ON "shift_registrations" ("verification_token")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_shift_registrations_group"
      ON "shift_registrations" ("registration_group_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop indexes
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_shift_registrations_group"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_shift_registrations_token"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_shift_registrations_email"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_shift_registrations_shift_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_shifts_date"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_shifts_job_date"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_shift_jobs_plan_order"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_shift_plans_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_shift_plans_public_slug"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_shift_plans_organization_created"`);

    // Drop tables in reverse order
    await queryRunner.query(`DROP TABLE IF EXISTS "shift_registrations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "shifts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "shift_jobs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "shift_plans"`);

    // Drop enums
    await queryRunner.query(`DROP TYPE IF EXISTS "shift_registration_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "shift_plan_status"`);
  }
}
