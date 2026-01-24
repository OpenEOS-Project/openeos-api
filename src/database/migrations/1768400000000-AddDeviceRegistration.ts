import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDeviceRegistration1768400000000 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Create device_status enum
        await queryRunner.query(`
            DO $$ BEGIN
                CREATE TYPE "device_status" AS ENUM ('pending', 'verified', 'blocked');
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;
        `);

        // Add new columns to devices table
        await queryRunner.query(`
            ALTER TABLE "devices"
            ADD COLUMN IF NOT EXISTS "status" "device_status" NOT NULL DEFAULT 'verified'
        `);

        await queryRunner.query(`
            ALTER TABLE "devices"
            ADD COLUMN IF NOT EXISTS "verification_code" varchar(6) NULL
        `);

        await queryRunner.query(`
            ALTER TABLE "devices"
            ADD COLUMN IF NOT EXISTS "verified_at" timestamp with time zone NULL
        `);

        await queryRunner.query(`
            ALTER TABLE "devices"
            ADD COLUMN IF NOT EXISTS "verified_by_id" uuid NULL
        `);

        await queryRunner.query(`
            ALTER TABLE "devices"
            ADD COLUMN IF NOT EXISTS "user_agent" varchar(500) NULL
        `);

        // Add foreign key for verified_by
        await queryRunner.query(`
            ALTER TABLE "devices"
            ADD CONSTRAINT "FK_devices_verified_by" FOREIGN KEY ("verified_by_id")
            REFERENCES "users"("id") ON DELETE SET NULL
        `);

        // Set existing devices to verified status and set verified_at to created_at
        await queryRunner.query(`
            UPDATE "devices"
            SET "status" = 'verified',
                "verified_at" = "created_at"
            WHERE "status" = 'verified' OR "status" IS NULL
        `);

        // Create index for organization + status queries
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_devices_organization_status"
            ON "devices" ("organization_id", "status")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_devices_organization_status"`);
        await queryRunner.query(`ALTER TABLE "devices" DROP CONSTRAINT IF EXISTS "FK_devices_verified_by"`);
        await queryRunner.query(`ALTER TABLE "devices" DROP COLUMN IF EXISTS "user_agent"`);
        await queryRunner.query(`ALTER TABLE "devices" DROP COLUMN IF EXISTS "verified_by_id"`);
        await queryRunner.query(`ALTER TABLE "devices" DROP COLUMN IF EXISTS "verified_at"`);
        await queryRunner.query(`ALTER TABLE "devices" DROP COLUMN IF EXISTS "verification_code"`);
        await queryRunner.query(`ALTER TABLE "devices" DROP COLUMN IF EXISTS "status"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "device_status"`);
    }

}
