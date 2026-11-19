import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Testzahlungen „Bar (Test)“ und „Karte (Test)“ (test-payment.util.ts):
 * eigene Werte im Enum `payment_method` (Zahlungen und Erstattungen), damit
 * jede Abfrage auf `payment_method = 'cash'` (Kassenbuch, Kassenlade,
 * Kellnerabrechnung, Berichte) sie von selbst nicht als Bargeld zaehlt.
 *
 * Nur neue Enum-Werte, keine Daten. Sie werden in dieser Migration nicht
 * benutzt, deshalb geht `ADD VALUE` in der Transaktion der Migration.
 */
export class AddTestPaymentMethods1844300000000 implements MigrationInterface {
  name = 'AddTestPaymentMethods1844300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "payment_method" ADD VALUE IF NOT EXISTS 'test_cash'`,
    );
    await queryRunner.query(
      `ALTER TYPE "payment_method" ADD VALUE IF NOT EXISTS 'test_card'`,
    );
    // `payments.payment_provider` ist varchar; sehr alte Datenbanken
    // hatten dafuer einen Enum-Typ.
    const providerExists = (await queryRunner.query(
      `SELECT 1 FROM pg_type WHERE typname = 'payment_provider'`,
    )) as unknown[];
    if (providerExists.length > 0) {
      await queryRunner.query(
        `ALTER TYPE "payment_provider" ADD VALUE IF NOT EXISTS 'TEST'`,
      );
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Enum-Werte lassen sich in PostgreSQL nicht entfernen.
  }
}
