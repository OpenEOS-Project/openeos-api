import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Support-Chat: ein fortlaufender Chat-Thread pro Organisation zwischen
 * Vereinsmitgliedern und dem Plattform-Support (Super-Admin), gespiegelt in
 * eine Telegram-Themengruppe (ein Thema je Organisation).
 */
export class AddSupportChat1803000000000 implements MigrationInterface {
  name = 'AddSupportChat1803000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "support_messages" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL,
        "user_id" uuid,
        "direction" character varying(10) NOT NULL,
        "body" text NOT NULL,
        "telegram_message_id" bigint,
        "read_by_admin_at" timestamptz,
        "read_by_user_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_support_messages" PRIMARY KEY ("id"),
        CONSTRAINT "FK_support_messages_organization" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_support_messages_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_support_messages_organization_created" ON "support_messages" ("organization_id", "created_at")`,
    );

    await queryRunner.query(
      `ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "priority_support" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "support_telegram_topic_id" integer`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP COLUMN IF EXISTS "support_telegram_topic_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP COLUMN IF EXISTS "priority_support"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "support_messages"`);
  }
}
