import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Die Telegram-Anbindung des Support-Chats und der Website-Formulare ist
 * entfernt: Anfragen bleiben in OpenEOS, der Support wird per E-Mail
 * benachrichtigt. Die Spalten mit den Telegram-IDs und der gespeicherte
 * Polling-Stand werden nicht mehr gebraucht.
 *
 * `down` legt nur die Spalten wieder an — die Telegram-IDs selbst sind weg.
 */
export class RemoveTelegramSupportBridge1815000000000 implements MigrationInterface {
  name = 'RemoveTelegramSupportBridge1815000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "support_messages" DROP COLUMN IF EXISTS "telegram_message_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP COLUMN IF EXISTS "support_telegram_topic_id"`,
    );
    await queryRunner.query(
      `DELETE FROM "platform_settings" WHERE "key" IN ('supportTelegramOffset', 'supportTelegramWebsiteTopicId')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "support_telegram_topic_id" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_messages" ADD COLUMN IF NOT EXISTS "telegram_message_id" bigint`,
    );
  }
}
