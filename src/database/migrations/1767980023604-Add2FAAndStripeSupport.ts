import { MigrationInterface, QueryRunner } from "typeorm";

export class Add2FAAndStripeSupport1767980023604 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Create enums (with IF NOT EXISTS pattern)
        await queryRunner.query(`
            DO $$ BEGIN
                CREATE TYPE "two_factor_method" AS ENUM ('totp', 'email');
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;
        `);

        await queryRunner.query(`
            DO $$ BEGIN
                CREATE TYPE "email_otp_purpose" AS ENUM ('two_factor_setup', 'two_factor_login', 'email_change');
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;
        `);

        await queryRunner.query(`
            DO $$ BEGIN
                CREATE TYPE "subscription_status" AS ENUM ('active', 'past_due', 'canceled', 'incomplete', 'trialing');
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;
        `);

        // Add 'stripe' to credit_payment_method enum
        await queryRunner.query(`
            ALTER TYPE "credit_payment_method" ADD VALUE IF NOT EXISTS 'stripe' BEFORE 'sumup_online'
        `);

        // ===========================================
        // Users table - 2FA and Preferences fields
        // ===========================================
        await queryRunner.query(`
            ALTER TABLE "users"
            ADD COLUMN IF NOT EXISTS "two_factor_enabled" boolean NOT NULL DEFAULT false,
            ADD COLUMN IF NOT EXISTS "two_factor_method" "two_factor_method" NULL,
            ADD COLUMN IF NOT EXISTS "two_factor_secret_encrypted" text NULL,
            ADD COLUMN IF NOT EXISTS "two_factor_backup_codes_hash" text NULL,
            ADD COLUMN IF NOT EXISTS "preferences" jsonb NOT NULL DEFAULT '{"theme": "system", "locale": "de", "notifications": {"email": true, "push": true}}',
            ADD COLUMN IF NOT EXISTS "pending_email" varchar(255) NULL,
            ADD COLUMN IF NOT EXISTS "pending_email_token" varchar(255) NULL,
            ADD COLUMN IF NOT EXISTS "pending_email_expires_at" timestamp with time zone NULL
        `);

        // ===========================================
        // Organizations table - Stripe fields
        // ===========================================
        await queryRunner.query(`
            ALTER TABLE "organizations"
            ADD COLUMN IF NOT EXISTS "stripe_customer_id" varchar(255) NULL,
            ADD COLUMN IF NOT EXISTS "stripe_subscription_id" varchar(255) NULL,
            ADD COLUMN IF NOT EXISTS "subscription_status" "subscription_status" NULL,
            ADD COLUMN IF NOT EXISTS "subscription_current_period_end" timestamp with time zone NULL,
            ADD COLUMN IF NOT EXISTS "subscription_credits_granted_at" timestamp with time zone NULL
        `);

        // Index for Stripe customer lookup
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_organizations_stripe_customer_id"
            ON "organizations" ("stripe_customer_id")
            WHERE "stripe_customer_id" IS NOT NULL
        `);

        // ===========================================
        // Credit Packages table - Stripe fields
        // ===========================================
        await queryRunner.query(`
            ALTER TABLE "credit_packages"
            ADD COLUMN IF NOT EXISTS "stripe_product_id" varchar(255) NULL,
            ADD COLUMN IF NOT EXISTS "stripe_price_id" varchar(255) NULL
        `);

        // ===========================================
        // Credit Purchases table - Stripe fields
        // ===========================================
        await queryRunner.query(`
            ALTER TABLE "credit_purchases"
            ADD COLUMN IF NOT EXISTS "stripe_payment_intent_id" varchar(255) NULL,
            ADD COLUMN IF NOT EXISTS "stripe_checkout_session_id" varchar(255) NULL
        `);

        // Index for Stripe checkout session lookup
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_credit_purchases_stripe_checkout_session_id"
            ON "credit_purchases" ("stripe_checkout_session_id")
            WHERE "stripe_checkout_session_id" IS NOT NULL
        `);

        // ===========================================
        // Trusted Devices table
        // ===========================================
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "trusted_devices" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "created_at" timestamp with time zone NOT NULL DEFAULT now(),
                "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
                "user_id" uuid NOT NULL,
                "device_fingerprint" varchar(255) NOT NULL,
                "device_name" varchar(255) NULL,
                "browser" varchar(100) NULL,
                "os" varchar(100) NULL,
                "ip_address" varchar(45) NULL,
                "last_used_at" timestamp with time zone NOT NULL DEFAULT now(),
                "expires_at" timestamp with time zone NOT NULL,
                CONSTRAINT "PK_trusted_devices" PRIMARY KEY ("id"),
                CONSTRAINT "FK_trusted_devices_user" FOREIGN KEY ("user_id")
                    REFERENCES "users"("id") ON DELETE CASCADE
            )
        `);

        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "IDX_trusted_devices_user_fingerprint"
            ON "trusted_devices" ("user_id", "device_fingerprint")
        `);

        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_trusted_devices_expires_at"
            ON "trusted_devices" ("expires_at")
        `);

        // ===========================================
        // Email OTPs table
        // ===========================================
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "email_otps" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "created_at" timestamp with time zone NOT NULL DEFAULT now(),
                "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
                "user_id" uuid NOT NULL,
                "code_hash" varchar(255) NOT NULL,
                "purpose" "email_otp_purpose" NOT NULL,
                "attempts" int NOT NULL DEFAULT 0,
                "max_attempts" int NOT NULL DEFAULT 3,
                "expires_at" timestamp with time zone NOT NULL,
                "used_at" timestamp with time zone NULL,
                CONSTRAINT "PK_email_otps" PRIMARY KEY ("id"),
                CONSTRAINT "FK_email_otps_user" FOREIGN KEY ("user_id")
                    REFERENCES "users"("id") ON DELETE CASCADE
            )
        `);

        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_email_otps_user_purpose"
            ON "email_otps" ("user_id", "purpose")
        `);

        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_email_otps_expires_at"
            ON "email_otps" ("expires_at")
        `);

        // ===========================================
        // Subscription Config table
        // ===========================================
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "subscription_config" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "created_at" timestamp with time zone NOT NULL DEFAULT now(),
                "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
                "name" varchar(100) NOT NULL,
                "description" text NULL,
                "price_monthly" decimal(10,2) NOT NULL,
                "credits_per_month" int NOT NULL,
                "stripe_product_id" varchar(255) NULL,
                "stripe_price_id" varchar(255) NULL,
                "is_active" boolean NOT NULL DEFAULT true,
                "features" jsonb NOT NULL DEFAULT '{}',
                CONSTRAINT "PK_subscription_config" PRIMARY KEY ("id")
            )
        `);

        await queryRunner.query(`
            CREATE INDEX "IDX_subscription_config_is_active"
            ON "subscription_config" ("is_active")
        `);

        // Insert default subscription config
        await queryRunner.query(`
            INSERT INTO "subscription_config" ("name", "description", "price_monthly", "credits_per_month", "features")
            VALUES (
                'OpenEOS Pro',
                'Monatliches Abonnement mit inkludierten Event-Credits',
                29.99,
                5,
                '{"support": "priority", "branding": true}'
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Drop subscription config table
        await queryRunner.query(`DROP TABLE IF EXISTS "subscription_config"`);

        // Drop email_otps table
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_email_otps_expires_at"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_email_otps_user_purpose"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "email_otps"`);

        // Drop trusted_devices table
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_trusted_devices_expires_at"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_trusted_devices_user_fingerprint"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "trusted_devices"`);

        // Drop credit_purchases Stripe columns
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_credit_purchases_stripe_checkout_session_id"`);
        await queryRunner.query(`
            ALTER TABLE "credit_purchases"
            DROP COLUMN IF EXISTS "stripe_checkout_session_id",
            DROP COLUMN IF EXISTS "stripe_payment_intent_id"
        `);

        // Drop credit_packages Stripe columns
        await queryRunner.query(`
            ALTER TABLE "credit_packages"
            DROP COLUMN IF EXISTS "stripe_price_id",
            DROP COLUMN IF EXISTS "stripe_product_id"
        `);

        // Drop organizations Stripe columns
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_organizations_stripe_customer_id"`);
        await queryRunner.query(`
            ALTER TABLE "organizations"
            DROP COLUMN IF EXISTS "subscription_credits_granted_at",
            DROP COLUMN IF EXISTS "subscription_current_period_end",
            DROP COLUMN IF EXISTS "subscription_status",
            DROP COLUMN IF EXISTS "stripe_subscription_id",
            DROP COLUMN IF EXISTS "stripe_customer_id"
        `);

        // Drop users 2FA and preferences columns
        await queryRunner.query(`
            ALTER TABLE "users"
            DROP COLUMN IF EXISTS "pending_email_expires_at",
            DROP COLUMN IF EXISTS "pending_email_token",
            DROP COLUMN IF EXISTS "pending_email",
            DROP COLUMN IF EXISTS "preferences",
            DROP COLUMN IF EXISTS "two_factor_backup_codes_hash",
            DROP COLUMN IF EXISTS "two_factor_secret_encrypted",
            DROP COLUMN IF EXISTS "two_factor_method",
            DROP COLUMN IF EXISTS "two_factor_enabled"
        `);

        // Drop enums (note: can't easily remove enum value 'stripe' from credit_payment_method)
        await queryRunner.query(`DROP TYPE IF EXISTS "subscription_status"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "email_otp_purpose"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "two_factor_method"`);
    }

}
