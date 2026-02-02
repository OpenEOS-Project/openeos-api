import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1700000000000 implements MigrationInterface {
  name = 'InitialSchema1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ========================================
    // 1. CREATE ENUM TYPES
    // ========================================

    // User-related enums
    await queryRunner.query(`
      CREATE TYPE "two_factor_method" AS ENUM ('totp', 'email')
    `);

    // Organization-related enums
    await queryRunner.query(`
      CREATE TYPE "discount_type" AS ENUM ('all', 'credits', 'hardware')
    `);

    await queryRunner.query(`
      CREATE TYPE "subscription_status" AS ENUM ('active', 'past_due', 'canceled', 'incomplete', 'trialing')
    `);

    await queryRunner.query(`
      CREATE TYPE "organization_role" AS ENUM ('admin', 'manager', 'cashier', 'kitchen', 'delivery')
    `);

    // Event-related enums
    await queryRunner.query(`
      CREATE TYPE "event_status" AS ENUM ('draft', 'active', 'completed', 'cancelled')
    `);

    // Device-related enums
    await queryRunner.query(`
      CREATE TYPE "device_type" AS ENUM ('pos', 'display_kitchen', 'display_delivery', 'display_menu', 'display_pickup', 'display_sales', 'admin')
    `);

    await queryRunner.query(`
      CREATE TYPE "device_status" AS ENUM ('pending', 'verified', 'blocked')
    `);

    // Printer-related enums
    await queryRunner.query(`
      CREATE TYPE "printer_type" AS ENUM ('receipt', 'kitchen', 'label')
    `);

    await queryRunner.query(`
      CREATE TYPE "printer_connection_type" AS ENUM ('network', 'usb', 'bluetooth')
    `);

    await queryRunner.query(`
      CREATE TYPE "print_template_type" AS ENUM ('receipt', 'kitchen_ticket', 'order_ticket')
    `);

    await queryRunner.query(`
      CREATE TYPE "print_job_status" AS ENUM ('queued', 'printing', 'completed', 'failed')
    `);

    // Order-related enums
    await queryRunner.query(`
      CREATE TYPE "order_status" AS ENUM ('open', 'in_progress', 'ready', 'completed', 'cancelled')
    `);

    await queryRunner.query(`
      CREATE TYPE "order_payment_status" AS ENUM ('unpaid', 'partly_paid', 'paid', 'refunded')
    `);

    await queryRunner.query(`
      CREATE TYPE "order_source" AS ENUM ('pos', 'online', 'qr_order')
    `);

    await queryRunner.query(`
      CREATE TYPE "order_priority" AS ENUM ('normal', 'high', 'rush')
    `);

    await queryRunner.query(`
      CREATE TYPE "order_item_status" AS ENUM ('pending', 'preparing', 'ready', 'delivered', 'cancelled')
    `);

    // Payment-related enums
    await queryRunner.query(`
      CREATE TYPE "payment_method" AS ENUM ('cash', 'card', 'sumup_terminal', 'sumup_online')
    `);

    await queryRunner.query(`
      CREATE TYPE "payment_transaction_status" AS ENUM ('pending', 'authorized', 'captured', 'failed', 'refunded')
    `);

    // QR Code enum
    await queryRunner.query(`
      CREATE TYPE "qr_code_type" AS ENUM ('table', 'takeaway', 'event')
    `);

    // Online order session enum
    await queryRunner.query(`
      CREATE TYPE "online_order_session_status" AS ENUM ('active', 'ordering', 'paid', 'completed', 'expired')
    `);

    // Workflow enum
    await queryRunner.query(`
      CREATE TYPE "workflow_run_status" AS ENUM ('running', 'completed', 'failed')
    `);

    // Stock movement enum
    await queryRunner.query(`
      CREATE TYPE "stock_movement_type" AS ENUM ('initial', 'sale', 'sale_cancelled', 'purchase', 'adjustment_plus', 'adjustment_minus', 'inventory_count', 'waste', 'transfer_in', 'transfer_out')
    `);

    // Inventory count enum
    await queryRunner.query(`
      CREATE TYPE "inventory_count_status" AS ENUM ('draft', 'in_progress', 'completed', 'cancelled')
    `);

    // Credit-related enums
    await queryRunner.query(`
      CREATE TYPE "credit_payment_method" AS ENUM ('stripe', 'sumup_online', 'bank_transfer', 'invoice')
    `);

    await queryRunner.query(`
      CREATE TYPE "credit_payment_status" AS ENUM ('pending', 'completed', 'failed', 'refunded')
    `);

    // Invoice enum
    await queryRunner.query(`
      CREATE TYPE "invoice_status" AS ENUM ('draft', 'pending', 'paid', 'cancelled')
    `);

    // Rental hardware enums
    await queryRunner.query(`
      CREATE TYPE "rental_hardware_type" AS ENUM ('printer', 'display')
    `);

    await queryRunner.query(`
      CREATE TYPE "rental_hardware_status" AS ENUM ('available', 'rented', 'maintenance', 'retired')
    `);

    await queryRunner.query(`
      CREATE TYPE "rental_assignment_status" AS ENUM ('pending', 'confirmed', 'active', 'returned', 'cancelled')
    `);

    // Admin audit log enum
    await queryRunner.query(`
      CREATE TYPE "admin_action" AS ENUM ('view_organization', 'impersonate_start', 'impersonate_end', 'credit_adjustment', 'edit_organization', 'delete_organization', 'edit_user', 'unlock_user', 'mark_invoice_paid', 'complete_purchase', 'set_discount', 'remove_discount', 'create_rental_hardware', 'assign_rental', 'return_rental')
    `);

    // Email OTP enum
    await queryRunner.query(`
      CREATE TYPE "email_otp_purpose" AS ENUM ('two_factor_setup', 'two_factor_login', 'email_change')
    `);

    // Shift-related enums
    await queryRunner.query(`
      CREATE TYPE "shift_plan_status" AS ENUM ('draft', 'published', 'closed')
    `);

    await queryRunner.query(`
      CREATE TYPE "shift_registration_status" AS ENUM ('pending_email', 'pending_approval', 'confirmed', 'rejected', 'cancelled')
    `);

    // ========================================
    // 2. CREATE BASE TABLES (no foreign keys to other tables)
    // ========================================

    // users table
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        "email" varchar(255) NOT NULL,
        "password_hash" varchar(255) NOT NULL,
        "first_name" varchar(100) NOT NULL,
        "last_name" varchar(100) NOT NULL,
        "avatar_url" varchar(500),
        "is_active" boolean NOT NULL DEFAULT true,
        "is_superadmin" boolean NOT NULL DEFAULT false,
        "email_verified_at" TIMESTAMP WITH TIME ZONE,
        "last_login_at" TIMESTAMP WITH TIME ZONE,
        "failed_login_attempts" int NOT NULL DEFAULT 0,
        "locked_until" TIMESTAMP WITH TIME ZONE,
        "password_reset_token" varchar(255),
        "password_reset_expires_at" TIMESTAMP WITH TIME ZONE,
        "two_factor_enabled" boolean NOT NULL DEFAULT false,
        "two_factor_method" "two_factor_method",
        "two_factor_secret_encrypted" text,
        "two_factor_backup_codes_hash" text,
        "preferences" jsonb NOT NULL DEFAULT '{"theme": "system", "locale": "de", "notifications": {"email": true, "push": true}}',
        "pending_email" varchar(255),
        "pending_email_token" varchar(255),
        "pending_email_expires_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_users" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_users_email" UNIQUE ("email")
      )
    `);

    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_users_email" ON "users" ("email")`);

    // organizations table
    await queryRunner.query(`
      CREATE TABLE "organizations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        "name" varchar(255) NOT NULL,
        "slug" varchar(100) NOT NULL,
        "logo_url" varchar(500),
        "settings" jsonb NOT NULL DEFAULT '{}',
        "event_credits" int NOT NULL DEFAULT 0,
        "billing_email" varchar(255),
        "billing_address" jsonb,
        "support_pin" varchar(6) NOT NULL,
        "discount_percent" decimal(5,2),
        "discount_type" "discount_type",
        "discount_valid_until" date,
        "discount_note" text,
        "stripe_customer_id" varchar(255),
        "stripe_subscription_id" varchar(255),
        "subscription_status" "subscription_status",
        "subscription_current_period_end" TIMESTAMP WITH TIME ZONE,
        "subscription_credits_granted_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_organizations" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_organizations_slug" UNIQUE ("slug")
      )
    `);

    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_organizations_slug" ON "organizations" ("slug")`);

    // credit_packages table (no foreign keys)
    await queryRunner.query(`
      CREATE TABLE "credit_packages" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "name" varchar(100) NOT NULL,
        "slug" varchar(50) NOT NULL,
        "description" text,
        "credits" int NOT NULL,
        "price" decimal(10,2) NOT NULL,
        "price_per_credit" decimal(10,2) NOT NULL,
        "savings_percent" int NOT NULL DEFAULT 0,
        "is_active" boolean NOT NULL DEFAULT true,
        "is_featured" boolean NOT NULL DEFAULT false,
        "sort_order" int NOT NULL DEFAULT 0,
        "stripe_product_id" varchar(255),
        "stripe_price_id" varchar(255),
        CONSTRAINT "PK_credit_packages" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_credit_packages_slug" UNIQUE ("slug")
      )
    `);

    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_credit_packages_slug" ON "credit_packages" ("slug")`);
    await queryRunner.query(`CREATE INDEX "IDX_credit_packages_sort_order" ON "credit_packages" ("sort_order")`);

    // rental_hardware table (no foreign keys)
    await queryRunner.query(`
      CREATE TABLE "rental_hardware" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "type" "rental_hardware_type" NOT NULL,
        "name" varchar(255) NOT NULL,
        "serial_number" varchar(100) NOT NULL,
        "model" varchar(255),
        "description" text,
        "daily_rate" decimal(10,2) NOT NULL,
        "status" "rental_hardware_status" NOT NULL DEFAULT 'available',
        "hardware_config" jsonb NOT NULL DEFAULT '{}',
        "notes" text,
        CONSTRAINT "PK_rental_hardware" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_rental_hardware_serial_number" UNIQUE ("serial_number")
      )
    `);

    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_rental_hardware_serial_number" ON "rental_hardware" ("serial_number")`);
    await queryRunner.query(`CREATE INDEX "IDX_rental_hardware_status" ON "rental_hardware" ("status")`);

    // subscription_config table (no foreign keys)
    await queryRunner.query(`
      CREATE TABLE "subscription_config" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "name" varchar(100) NOT NULL,
        "description" text,
        "price_monthly" decimal(10,2) NOT NULL,
        "credits_per_month" int NOT NULL,
        "stripe_product_id" varchar(255),
        "stripe_price_id" varchar(255),
        "is_active" boolean NOT NULL DEFAULT true,
        "features" jsonb NOT NULL DEFAULT '{}',
        CONSTRAINT "PK_subscription_config" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_subscription_config_is_active" ON "subscription_config" ("is_active")`);

    // ========================================
    // 3. CREATE TABLES WITH FOREIGN KEYS TO BASE TABLES
    // ========================================

    // user_organizations table (FK to users and organizations)
    await queryRunner.query(`
      CREATE TABLE "user_organizations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "organization_id" uuid NOT NULL,
        "role" "organization_role" NOT NULL,
        "permissions" jsonb NOT NULL DEFAULT '{}',
        CONSTRAINT "PK_user_organizations" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_user_organizations_user_org" UNIQUE ("user_id", "organization_id"),
        CONSTRAINT "FK_user_organizations_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_user_organizations_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_user_organizations_user_id" ON "user_organizations" ("user_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_user_organizations_organization_id" ON "user_organizations" ("organization_id")`);

    // refresh_tokens table (FK to users)
    await queryRunner.query(`
      CREATE TABLE "refresh_tokens" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "token_hash" varchar(255) NOT NULL,
        "device_info" varchar(255),
        "ip_address" varchar(45),
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_refresh_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "FK_refresh_tokens_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_refresh_tokens_user_id" ON "refresh_tokens" ("user_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_refresh_tokens_token_hash" ON "refresh_tokens" ("token_hash")`);
    await queryRunner.query(`CREATE INDEX "IDX_refresh_tokens_expires_at" ON "refresh_tokens" ("expires_at")`);

    // trusted_devices table (FK to users)
    await queryRunner.query(`
      CREATE TABLE "trusted_devices" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "device_fingerprint" varchar(255) NOT NULL,
        "device_name" varchar(255),
        "browser" varchar(100),
        "os" varchar(100),
        "ip_address" varchar(45),
        "last_used_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_trusted_devices" PRIMARY KEY ("id"),
        CONSTRAINT "FK_trusted_devices_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_trusted_devices_user_fingerprint" ON "trusted_devices" ("user_id", "device_fingerprint")`);
    await queryRunner.query(`CREATE INDEX "IDX_trusted_devices_expires_at" ON "trusted_devices" ("expires_at")`);

    // email_otps table (FK to users)
    await queryRunner.query(`
      CREATE TABLE "email_otps" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "code_hash" varchar(255) NOT NULL,
        "purpose" "email_otp_purpose" NOT NULL,
        "attempts" int NOT NULL DEFAULT 0,
        "max_attempts" int NOT NULL DEFAULT 3,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "used_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_email_otps" PRIMARY KEY ("id"),
        CONSTRAINT "FK_email_otps_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_email_otps_user_purpose" ON "email_otps" ("user_id", "purpose")`);
    await queryRunner.query(`CREATE INDEX "IDX_email_otps_expires_at" ON "email_otps" ("expires_at")`);

    // invitations table (FK to organizations and users)
    await queryRunner.query(`
      CREATE TABLE "invitations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" uuid NOT NULL,
        "email" varchar(255) NOT NULL,
        "role" "organization_role" NOT NULL,
        "token" varchar(255) NOT NULL,
        "invited_by_user_id" uuid NOT NULL,
        "accepted_at" TIMESTAMP WITH TIME ZONE,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_invitations" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_invitations_token" UNIQUE ("token"),
        CONSTRAINT "FK_invitations_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_invitations_invited_by" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_invitations_token" ON "invitations" ("token")`);
    await queryRunner.query(`CREATE INDEX "IDX_invitations_organization_email" ON "invitations" ("organization_id", "email")`);

    // devices table (FK to organizations and users)
    await queryRunner.query(`
      CREATE TABLE "devices" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" uuid,
        "suggested_name" varchar(255),
        "name" varchar(255) NOT NULL,
        "type" "device_type" NOT NULL,
        "device_token" varchar(255) NOT NULL,
        "last_seen_at" TIMESTAMP WITH TIME ZONE,
        "is_active" boolean NOT NULL DEFAULT true,
        "status" "device_status" NOT NULL DEFAULT 'pending',
        "verification_code" varchar(6),
        "verified_at" TIMESTAMP WITH TIME ZONE,
        "verified_by_id" uuid,
        "user_agent" varchar(500),
        "settings" jsonb NOT NULL DEFAULT '{}',
        CONSTRAINT "PK_devices" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_devices_device_token" UNIQUE ("device_token"),
        CONSTRAINT "FK_devices_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_devices_verified_by" FOREIGN KEY ("verified_by_id") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_devices_organization_id" ON "devices" ("organization_id")`);

    // printers table (FK to organizations)
    await queryRunner.query(`
      CREATE TABLE "printers" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" uuid NOT NULL,
        "name" varchar(255) NOT NULL,
        "type" "printer_type" NOT NULL,
        "connection_type" "printer_connection_type" NOT NULL,
        "connection_config" jsonb NOT NULL DEFAULT '{}',
        "agent_id" varchar(255),
        "is_active" boolean NOT NULL DEFAULT true,
        "is_online" boolean NOT NULL DEFAULT false,
        "last_seen_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_printers" PRIMARY KEY ("id"),
        CONSTRAINT "FK_printers_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_printers_organization_id" ON "printers" ("organization_id")`);

    // print_templates table (FK to organizations)
    await queryRunner.query(`
      CREATE TABLE "print_templates" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" uuid NOT NULL,
        "name" varchar(255) NOT NULL,
        "type" "print_template_type" NOT NULL,
        "template" jsonb NOT NULL DEFAULT '{}',
        "is_default" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_print_templates" PRIMARY KEY ("id"),
        CONSTRAINT "FK_print_templates_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_print_templates_organization_id" ON "print_templates" ("organization_id")`);

    // workflows table (FK to organizations)
    await queryRunner.query(`
      CREATE TABLE "workflows" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" uuid NOT NULL,
        "name" varchar(255) NOT NULL,
        "description" text,
        "trigger_type" varchar(50) NOT NULL,
        "trigger_config" jsonb NOT NULL DEFAULT '{}',
        "nodes" jsonb NOT NULL DEFAULT '[]',
        "edges" jsonb NOT NULL DEFAULT '[]',
        "is_active" boolean NOT NULL DEFAULT false,
        "is_system" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_workflows" PRIMARY KEY ("id"),
        CONSTRAINT "FK_workflows_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_workflows_organization_id" ON "workflows" ("organization_id")`);

    // workflow_runs table (FK to workflows)
    await queryRunner.query(`
      CREATE TABLE "workflow_runs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "workflow_id" uuid NOT NULL,
        "trigger_event" varchar(50) NOT NULL,
        "trigger_data" jsonb NOT NULL DEFAULT '{}',
        "status" "workflow_run_status" NOT NULL DEFAULT 'running',
        "started_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "error" text,
        "execution_log" jsonb NOT NULL DEFAULT '[]',
        CONSTRAINT "PK_workflow_runs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_workflow_runs_workflow" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_workflow_runs_workflow_id" ON "workflow_runs" ("workflow_id")`);

    // workflow_events table (FK to organizations)
    await queryRunner.query(`
      CREATE TABLE "workflow_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" uuid NOT NULL,
        "event_type" varchar(50) NOT NULL,
        "payload" jsonb NOT NULL DEFAULT '{}',
        "processed" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_workflow_events" PRIMARY KEY ("id"),
        CONSTRAINT "FK_workflow_events_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_workflow_events_organization_processed" ON "workflow_events" ("organization_id", "processed")`);

    // invoices table (FK to organizations)
    await queryRunner.query(`
      CREATE TABLE "invoices" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" uuid NOT NULL,
        "invoice_number" varchar(50) NOT NULL,
        "status" "invoice_status" NOT NULL DEFAULT 'draft',
        "subtotal" decimal(10,2) NOT NULL,
        "tax_rate" decimal(5,2) NOT NULL DEFAULT 19.0,
        "tax_amount" decimal(10,2) NOT NULL,
        "total" decimal(10,2) NOT NULL,
        "currency" varchar(3) NOT NULL DEFAULT 'EUR',
        "paid_at" TIMESTAMP WITH TIME ZONE,
        "pdf_url" varchar(500),
        "line_items" jsonb NOT NULL DEFAULT '[]',
        "billing_address" jsonb,
        CONSTRAINT "PK_invoices" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_invoices_invoice_number" UNIQUE ("invoice_number"),
        CONSTRAINT "FK_invoices_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_invoices_organization_created" ON "invoices" ("organization_id", "created_at")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_invoices_invoice_number" ON "invoices" ("invoice_number")`);

    // admin_audit_logs table (FK to users and organizations)
    await queryRunner.query(`
      CREATE TABLE "admin_audit_logs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "admin_user_id" uuid NOT NULL,
        "organization_id" uuid,
        "action" "admin_action" NOT NULL,
        "resource_type" varchar(50) NOT NULL,
        "resource_id" uuid,
        "details" jsonb NOT NULL DEFAULT '{}',
        "reason" text,
        "ip_address" varchar(45) NOT NULL,
        "user_agent" varchar(500),
        CONSTRAINT "PK_admin_audit_logs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_admin_audit_logs_admin_user" FOREIGN KEY ("admin_user_id") REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_admin_audit_logs_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_admin_audit_logs_admin_created" ON "admin_audit_logs" ("admin_user_id", "created_at")`);
    await queryRunner.query(`CREATE INDEX "IDX_admin_audit_logs_organization_created" ON "admin_audit_logs" ("organization_id", "created_at")`);

    // events table (FK to organizations, self-reference)
    await queryRunner.query(`
      CREATE TABLE "events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" uuid NOT NULL,
        "copied_from_event_id" uuid,
        "name" varchar(255) NOT NULL,
        "description" text,
        "start_date" TIMESTAMP WITH TIME ZONE NOT NULL,
        "end_date" TIMESTAMP WITH TIME ZONE NOT NULL,
        "status" "event_status" NOT NULL DEFAULT 'draft',
        "settings" jsonb NOT NULL DEFAULT '{}',
        CONSTRAINT "PK_events" PRIMARY KEY ("id"),
        CONSTRAINT "FK_events_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_events_copied_from" FOREIGN KEY ("copied_from_event_id") REFERENCES "events"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_events_organization_created" ON "events" ("organization_id", "created_at")`);
    await queryRunner.query(`CREATE INDEX "IDX_events_status" ON "events" ("status")`);

    // shift_plans table (FK to organizations and events)
    await queryRunner.query(`
      CREATE TABLE "shift_plans" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" uuid NOT NULL,
        "event_id" uuid,
        "name" varchar(255) NOT NULL,
        "description" text,
        "public_slug" varchar(100) NOT NULL,
        "status" "shift_plan_status" NOT NULL DEFAULT 'draft',
        "settings" jsonb NOT NULL DEFAULT '{"requireApproval": true, "allowMultipleShifts": true, "reminderDaysBefore": 1}',
        CONSTRAINT "PK_shift_plans" PRIMARY KEY ("id"),
        CONSTRAINT "FK_shift_plans_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_shift_plans_event" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_shift_plans_organization_created" ON "shift_plans" ("organization_id", "created_at")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_shift_plans_public_slug" ON "shift_plans" ("public_slug")`);
    await queryRunner.query(`CREATE INDEX "IDX_shift_plans_status" ON "shift_plans" ("status")`);

    // shift_jobs table (FK to shift_plans)
    await queryRunner.query(`
      CREATE TABLE "shift_jobs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "shift_plan_id" uuid NOT NULL,
        "name" varchar(100) NOT NULL,
        "description" text,
        "color" varchar(7),
        "sort_order" int NOT NULL DEFAULT 0,
        CONSTRAINT "PK_shift_jobs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_shift_jobs_shift_plan" FOREIGN KEY ("shift_plan_id") REFERENCES "shift_plans"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_shift_jobs_shift_plan_sort" ON "shift_jobs" ("shift_plan_id", "sort_order")`);

    // shifts table (FK to shift_jobs)
    await queryRunner.query(`
      CREATE TABLE "shifts" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "shift_job_id" uuid NOT NULL,
        "date" date NOT NULL,
        "start_time" time NOT NULL,
        "end_time" time NOT NULL,
        "required_workers" int NOT NULL DEFAULT 1,
        "notes" text,
        CONSTRAINT "PK_shifts" PRIMARY KEY ("id"),
        CONSTRAINT "FK_shifts_shift_job" FOREIGN KEY ("shift_job_id") REFERENCES "shift_jobs"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_shifts_shift_job_date" ON "shifts" ("shift_job_id", "date")`);
    await queryRunner.query(`CREATE INDEX "IDX_shifts_date" ON "shifts" ("date")`);

    // shift_registrations table (FK to shifts)
    await queryRunner.query(`
      CREATE TABLE "shift_registrations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "shift_id" uuid NOT NULL,
        "registration_group_id" uuid NOT NULL,
        "name" varchar(255) NOT NULL,
        "email" varchar(255) NOT NULL,
        "phone" varchar(50),
        "notes" text,
        "status" "shift_registration_status" NOT NULL DEFAULT 'pending_email',
        "email_verified_at" TIMESTAMP WITH TIME ZONE,
        "verification_token" varchar(64) NOT NULL,
        "admin_notes" text,
        "reminder_sent_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_shift_registrations" PRIMARY KEY ("id"),
        CONSTRAINT "FK_shift_registrations_shift" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_shift_registrations_shift_status" ON "shift_registrations" ("shift_id", "status")`);
    await queryRunner.query(`CREATE INDEX "IDX_shift_registrations_email" ON "shift_registrations" ("email")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_shift_registrations_verification_token" ON "shift_registrations" ("verification_token")`);
    await queryRunner.query(`CREATE INDEX "IDX_shift_registrations_group_id" ON "shift_registrations" ("registration_group_id")`);

    // categories table (FK to events, self-reference)
    await queryRunner.query(`
      CREATE TABLE "categories" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "event_id" uuid NOT NULL,
        "parent_id" uuid,
        "name" varchar(255) NOT NULL,
        "description" text,
        "color" varchar(7),
        "icon" varchar(50),
        "sort_order" int NOT NULL DEFAULT 0,
        "is_active" boolean NOT NULL DEFAULT true,
        "print_settings" jsonb,
        CONSTRAINT "PK_categories" PRIMARY KEY ("id"),
        CONSTRAINT "FK_categories_event" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_categories_parent" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_categories_event_sort" ON "categories" ("event_id", "sort_order")`);
    await queryRunner.query(`CREATE INDEX "IDX_categories_event_active" ON "categories" ("event_id", "is_active")`);

    // products table (FK to events and categories)
    await queryRunner.query(`
      CREATE TABLE "products" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        "event_id" uuid NOT NULL,
        "category_id" uuid NOT NULL,
        "name" varchar(255) NOT NULL,
        "description" text,
        "price" decimal(10,2) NOT NULL,
        "image_url" varchar(500),
        "is_active" boolean NOT NULL DEFAULT true,
        "is_available" boolean NOT NULL DEFAULT true,
        "track_inventory" boolean NOT NULL DEFAULT false,
        "stock_quantity" int NOT NULL DEFAULT 0,
        "stock_unit" varchar(20) NOT NULL DEFAULT 'Stück',
        "options" jsonb NOT NULL DEFAULT '{"groups": []}',
        "print_settings" jsonb,
        "sort_order" int NOT NULL DEFAULT 0,
        CONSTRAINT "PK_products" PRIMARY KEY ("id"),
        CONSTRAINT "FK_products_event" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_products_category" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_products_event_active" ON "products" ("event_id", "is_active")`);
    await queryRunner.query(`CREATE INDEX "IDX_products_event_category" ON "products" ("event_id", "category_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_products_category_id" ON "products" ("category_id")`);

    // qr_codes table (FK to organizations and events)
    await queryRunner.query(`
      CREATE TABLE "qr_codes" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" uuid NOT NULL,
        "event_id" uuid,
        "code" varchar(50) NOT NULL,
        "type" "qr_code_type" NOT NULL,
        "table_number" varchar(20),
        "name" varchar(100),
        "is_active" boolean NOT NULL DEFAULT true,
        "scan_count" int NOT NULL DEFAULT 0,
        "last_scanned_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_qr_codes" PRIMARY KEY ("id"),
        CONSTRAINT "FK_qr_codes_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_qr_codes_event" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_qr_codes_organization_code" ON "qr_codes" ("organization_id", "code")`);
    await queryRunner.query(`CREATE INDEX "IDX_qr_codes_event_id" ON "qr_codes" ("event_id")`);

    // online_order_sessions table (FK to organizations, events, qr_codes)
    await queryRunner.query(`
      CREATE TABLE "online_order_sessions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" uuid NOT NULL,
        "event_id" uuid,
        "qr_code_id" uuid NOT NULL,
        "session_token" varchar(255) NOT NULL,
        "table_number" varchar(20),
        "customer_name" varchar(100),
        "status" "online_order_session_status" NOT NULL DEFAULT 'active',
        "cart" jsonb NOT NULL DEFAULT '{"items": [], "updatedAt": ""}',
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_online_order_sessions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_online_order_sessions_session_token" UNIQUE ("session_token"),
        CONSTRAINT "FK_online_order_sessions_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_online_order_sessions_event" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_online_order_sessions_qr_code" FOREIGN KEY ("qr_code_id") REFERENCES "qr_codes"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_online_order_sessions_session_token" ON "online_order_sessions" ("session_token")`);
    await queryRunner.query(`CREATE INDEX "IDX_online_order_sessions_organization_status" ON "online_order_sessions" ("organization_id", "status")`);

    // orders table (FK to organizations, events, users, devices, online_order_sessions)
    await queryRunner.query(`
      CREATE TABLE "orders" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" uuid NOT NULL,
        "event_id" uuid,
        "order_number" varchar(50) NOT NULL,
        "daily_number" int NOT NULL,
        "table_number" varchar(20),
        "customer_name" varchar(255),
        "customer_phone" varchar(50),
        "status" "order_status" NOT NULL DEFAULT 'open',
        "payment_status" "order_payment_status" NOT NULL DEFAULT 'unpaid',
        "source" "order_source" NOT NULL DEFAULT 'pos',
        "subtotal" decimal(10,2) NOT NULL DEFAULT 0,
        "tax_total" decimal(10,2) NOT NULL DEFAULT 0,
        "total" decimal(10,2) NOT NULL DEFAULT 0,
        "paid_amount" decimal(10,2) NOT NULL DEFAULT 0,
        "tip_amount" decimal(10,2) NOT NULL DEFAULT 0,
        "discount_amount" decimal(10,2) NOT NULL DEFAULT 0,
        "discount_reason" varchar(255),
        "notes" text,
        "priority" "order_priority" NOT NULL DEFAULT 'normal',
        "estimated_ready_at" TIMESTAMP WITH TIME ZONE,
        "ready_at" TIMESTAMP WITH TIME ZONE,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "cancelled_at" TIMESTAMP WITH TIME ZONE,
        "cancellation_reason" varchar(255),
        "created_by_user_id" uuid,
        "created_by_device_id" uuid,
        "online_session_id" uuid,
        CONSTRAINT "PK_orders" PRIMARY KEY ("id"),
        CONSTRAINT "FK_orders_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_orders_event" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_orders_created_by_user" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_orders_created_by_device" FOREIGN KEY ("created_by_device_id") REFERENCES "devices"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_orders_online_session" FOREIGN KEY ("online_session_id") REFERENCES "online_order_sessions"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_orders_organization_created" ON "orders" ("organization_id", "created_at")`);
    await queryRunner.query(`CREATE INDEX "IDX_orders_order_number" ON "orders" ("order_number")`);
    await queryRunner.query(`CREATE INDEX "IDX_orders_event_daily" ON "orders" ("event_id", "daily_number")`);
    await queryRunner.query(`CREATE INDEX "IDX_orders_status_payment" ON "orders" ("status", "payment_status")`);

    // order_items table (FK to orders, products, categories)
    await queryRunner.query(`
      CREATE TABLE "order_items" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "order_id" uuid NOT NULL,
        "product_id" uuid NOT NULL,
        "category_id" uuid NOT NULL,
        "product_name" varchar(255) NOT NULL,
        "category_name" varchar(255) NOT NULL,
        "quantity" int NOT NULL,
        "unit_price" decimal(10,2) NOT NULL,
        "options_price" decimal(10,2) NOT NULL DEFAULT 0,
        "tax_rate" decimal(5,2) NOT NULL,
        "total_price" decimal(10,2) NOT NULL,
        "options" jsonb NOT NULL DEFAULT '{"selected": []}',
        "status" "order_item_status" NOT NULL DEFAULT 'pending',
        "notes" text,
        "kitchen_notes" text,
        "paid_quantity" int NOT NULL DEFAULT 0,
        "prepared_at" TIMESTAMP WITH TIME ZONE,
        "ready_at" TIMESTAMP WITH TIME ZONE,
        "delivered_at" TIMESTAMP WITH TIME ZONE,
        "sort_order" int NOT NULL DEFAULT 0,
        CONSTRAINT "PK_order_items" PRIMARY KEY ("id"),
        CONSTRAINT "FK_order_items_order" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_order_items_product" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_order_items_category" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_order_items_order_id" ON "order_items" ("order_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_order_items_order_status" ON "order_items" ("order_id", "status")`);
    await queryRunner.query(`CREATE INDEX "IDX_order_items_product_id" ON "order_items" ("product_id")`);

    // payments table (FK to orders, users, devices)
    await queryRunner.query(`
      CREATE TABLE "payments" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "order_id" uuid NOT NULL,
        "amount" decimal(10,2) NOT NULL,
        "payment_method" "payment_method" NOT NULL,
        "payment_provider" varchar(50) NOT NULL,
        "provider_transaction_id" varchar(255),
        "status" "payment_transaction_status" NOT NULL DEFAULT 'pending',
        "metadata" jsonb NOT NULL DEFAULT '{}',
        "processed_by_user_id" uuid,
        "processed_by_device_id" uuid,
        CONSTRAINT "PK_payments" PRIMARY KEY ("id"),
        CONSTRAINT "FK_payments_order" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_payments_processed_by_user" FOREIGN KEY ("processed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_payments_processed_by_device" FOREIGN KEY ("processed_by_device_id") REFERENCES "devices"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_payments_order_id" ON "payments" ("order_id")`);

    // order_item_payments table (FK to payments, order_items)
    await queryRunner.query(`
      CREATE TABLE "order_item_payments" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "payment_id" uuid NOT NULL,
        "order_item_id" uuid NOT NULL,
        "quantity" int NOT NULL,
        "amount" decimal(10,2) NOT NULL,
        CONSTRAINT "PK_order_item_payments" PRIMARY KEY ("id"),
        CONSTRAINT "FK_order_item_payments_payment" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_order_item_payments_order_item" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_order_item_payments_payment_id" ON "order_item_payments" ("payment_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_order_item_payments_order_item_id" ON "order_item_payments" ("order_item_id")`);

    // print_jobs table (FK to organizations, printers, print_templates, orders, order_items)
    await queryRunner.query(`
      CREATE TABLE "print_jobs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" uuid NOT NULL,
        "printer_id" uuid NOT NULL,
        "template_id" uuid,
        "order_id" uuid,
        "order_item_id" uuid,
        "status" "print_job_status" NOT NULL DEFAULT 'queued',
        "payload" jsonb NOT NULL DEFAULT '{}',
        "error" text,
        "attempts" int NOT NULL DEFAULT 0,
        "printed_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_print_jobs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_print_jobs_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_print_jobs_printer" FOREIGN KEY ("printer_id") REFERENCES "printers"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_print_jobs_template" FOREIGN KEY ("template_id") REFERENCES "print_templates"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_print_jobs_order" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_print_jobs_order_item" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_print_jobs_printer_status" ON "print_jobs" ("printer_id", "status")`);
    await queryRunner.query(`CREATE INDEX "IDX_print_jobs_organization_id" ON "print_jobs" ("organization_id")`);

    // stock_movements table (FK to events, products, users)
    await queryRunner.query(`
      CREATE TABLE "stock_movements" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "event_id" uuid NOT NULL,
        "product_id" uuid NOT NULL,
        "type" "stock_movement_type" NOT NULL,
        "quantity" int NOT NULL,
        "quantity_before" int NOT NULL,
        "quantity_after" int NOT NULL,
        "reference_type" varchar(50),
        "reference_id" uuid,
        "reason" varchar(255),
        "notes" text,
        "created_by_user_id" uuid,
        CONSTRAINT "PK_stock_movements" PRIMARY KEY ("id"),
        CONSTRAINT "FK_stock_movements_event" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_stock_movements_product" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_stock_movements_created_by" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_stock_movements_product_created" ON "stock_movements" ("product_id", "created_at")`);
    await queryRunner.query(`CREATE INDEX "IDX_stock_movements_event_created" ON "stock_movements" ("event_id", "created_at")`);

    // inventory_counts table (FK to events, users)
    await queryRunner.query(`
      CREATE TABLE "inventory_counts" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "event_id" uuid NOT NULL,
        "name" varchar(255) NOT NULL,
        "status" "inventory_count_status" NOT NULL DEFAULT 'draft',
        "started_at" TIMESTAMP WITH TIME ZONE,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "notes" text,
        "created_by_user_id" uuid NOT NULL,
        "completed_by_user_id" uuid,
        CONSTRAINT "PK_inventory_counts" PRIMARY KEY ("id"),
        CONSTRAINT "FK_inventory_counts_event" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_inventory_counts_created_by" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_inventory_counts_completed_by" FOREIGN KEY ("completed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_inventory_counts_event_id" ON "inventory_counts" ("event_id")`);

    // inventory_count_items table (FK to inventory_counts, products, users)
    await queryRunner.query(`
      CREATE TABLE "inventory_count_items" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "inventory_count_id" uuid NOT NULL,
        "product_id" uuid NOT NULL,
        "expected_quantity" int NOT NULL,
        "counted_quantity" int,
        "difference" int,
        "notes" text,
        "counted_by_user_id" uuid,
        "counted_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_inventory_count_items" PRIMARY KEY ("id"),
        CONSTRAINT "FK_inventory_count_items_inventory_count" FOREIGN KEY ("inventory_count_id") REFERENCES "inventory_counts"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_inventory_count_items_product" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_inventory_count_items_counted_by" FOREIGN KEY ("counted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_inventory_count_items_inventory_count_id" ON "inventory_count_items" ("inventory_count_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_inventory_count_items_product_id" ON "inventory_count_items" ("product_id")`);

    // credit_purchases table (FK to organizations, credit_packages, users, invoices)
    await queryRunner.query(`
      CREATE TABLE "credit_purchases" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" uuid NOT NULL,
        "package_id" uuid NOT NULL,
        "credits" int NOT NULL,
        "amount" decimal(10,2) NOT NULL,
        "payment_method" "credit_payment_method" NOT NULL,
        "payment_status" "credit_payment_status" NOT NULL DEFAULT 'pending',
        "transaction_id" varchar(255),
        "invoice_id" uuid,
        "purchased_by_user_id" uuid NOT NULL,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "stripe_payment_intent_id" varchar(255),
        "stripe_checkout_session_id" varchar(255),
        CONSTRAINT "PK_credit_purchases" PRIMARY KEY ("id"),
        CONSTRAINT "FK_credit_purchases_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_credit_purchases_package" FOREIGN KEY ("package_id") REFERENCES "credit_packages"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_credit_purchases_purchased_by" FOREIGN KEY ("purchased_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_credit_purchases_invoice" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_credit_purchases_organization_created" ON "credit_purchases" ("organization_id", "created_at")`);

    // event_licenses table (FK to organizations, events, users)
    await queryRunner.query(`
      CREATE TABLE "event_licenses" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" uuid NOT NULL,
        "event_id" uuid NOT NULL,
        "license_date" date NOT NULL,
        "credits_used" int NOT NULL DEFAULT 1,
        "activated_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "activated_by_user_id" uuid NOT NULL,
        CONSTRAINT "PK_event_licenses" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_event_licenses_event_date" UNIQUE ("event_id", "license_date"),
        CONSTRAINT "FK_event_licenses_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_event_licenses_event" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_event_licenses_activated_by" FOREIGN KEY ("activated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_event_licenses_organization_date" ON "event_licenses" ("organization_id", "license_date")`);
    await queryRunner.query(`CREATE INDEX "IDX_event_licenses_event_id" ON "event_licenses" ("event_id")`);

    // rental_assignments table (FK to rental_hardware, organizations, events, users, invoices)
    await queryRunner.query(`
      CREATE TABLE "rental_assignments" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "rental_hardware_id" uuid NOT NULL,
        "organization_id" uuid NOT NULL,
        "event_id" uuid,
        "status" "rental_assignment_status" NOT NULL DEFAULT 'pending',
        "start_date" date NOT NULL,
        "end_date" date NOT NULL,
        "daily_rate" decimal(10,2) NOT NULL,
        "total_days" int NOT NULL,
        "total_amount" decimal(10,2) NOT NULL,
        "notes" text,
        "assigned_by_user_id" uuid NOT NULL,
        "confirmed_at" TIMESTAMP WITH TIME ZONE,
        "pickup_at" TIMESTAMP WITH TIME ZONE,
        "returned_at" TIMESTAMP WITH TIME ZONE,
        "invoice_id" uuid,
        CONSTRAINT "PK_rental_assignments" PRIMARY KEY ("id"),
        CONSTRAINT "FK_rental_assignments_rental_hardware" FOREIGN KEY ("rental_hardware_id") REFERENCES "rental_hardware"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_rental_assignments_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_rental_assignments_event" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_rental_assignments_assigned_by" FOREIGN KEY ("assigned_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_rental_assignments_invoice" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_rental_assignments_hardware_status" ON "rental_assignments" ("rental_hardware_id", "status")`);
    await queryRunner.query(`CREATE INDEX "IDX_rental_assignments_organization_start" ON "rental_assignments" ("organization_id", "start_date")`);
    await queryRunner.query(`CREATE INDEX "IDX_rental_assignments_event_id" ON "rental_assignments" ("event_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // ========================================
    // DROP TABLES IN REVERSE ORDER (most dependent first)
    // ========================================

    await queryRunner.query(`DROP TABLE IF EXISTS "rental_assignments"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "event_licenses"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "credit_purchases"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "inventory_count_items"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "inventory_counts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "stock_movements"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "print_jobs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "order_item_payments"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "payments"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "order_items"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "orders"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "online_order_sessions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "qr_codes"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "products"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "categories"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "shift_registrations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "shifts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "shift_jobs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "shift_plans"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "admin_audit_logs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "invoices"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "workflow_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "workflow_runs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "workflows"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "print_templates"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "printers"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "devices"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "invitations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "email_otps"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "trusted_devices"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "refresh_tokens"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_organizations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "subscription_config"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "rental_hardware"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "credit_packages"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "organizations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);

    // ========================================
    // DROP ENUM TYPES
    // ========================================

    await queryRunner.query(`DROP TYPE IF EXISTS "shift_registration_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "shift_plan_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "email_otp_purpose"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "admin_action"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "rental_assignment_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "rental_hardware_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "rental_hardware_type"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "invoice_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "credit_payment_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "credit_payment_method"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "inventory_count_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "stock_movement_type"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "workflow_run_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "online_order_session_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "qr_code_type"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "payment_transaction_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "payment_method"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "order_item_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "order_priority"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "order_source"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "order_payment_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "order_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "print_job_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "print_template_type"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "printer_connection_type"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "printer_type"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "device_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "device_type"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "event_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "organization_role"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "subscription_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "discount_type"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "two_factor_method"`);
  }
}
