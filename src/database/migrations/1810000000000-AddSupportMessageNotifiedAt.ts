import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `notified_at` fuer Support-Nachrichten.
 *
 * Haelt fest, wegen welcher Antwort bereits eine E-Mail hinausging.
 * Vorher wurde ersatzweise gezaehlt, wie viele Antworten ungelesen sind,
 * und nur bei genau einer verschickt — wer gelesen hatte und danach zwei
 * Antworten bekam, erfuhr davon nichts mehr.
 */
export class AddSupportMessageNotifiedAt1810000000000 implements MigrationInterface {
  name = 'AddSupportMessageNotifiedAt1810000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS notified_at timestamp with time zone
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE support_messages DROP COLUMN IF EXISTS notified_at`);
  }
}
