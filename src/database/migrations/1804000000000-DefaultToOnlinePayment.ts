import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Online-Zahlung wird der Regelweg für die Freischaltung einer Veranstaltung.
 *
 * Bisher stand `billing_mode` auf 'invoice', weil es nichts anderes gab.
 * Mit Stripe ist 'prepaid' der Normalfall; 'invoice' bleibt als Ausnahme für
 * Organisationen, denen der Kauf auf Rechnung eingeräumt wurde.
 *
 * Umgestellt werden nur Organisationen, die den Rechnungsweg noch nie
 * benutzt haben. Wer bereits auf Rechnung bestellt hat, behält ihn — eine
 * laufende Geschäftsbeziehung wird nicht durch eine Migration gekündigt.
 */
export class DefaultToOnlinePayment1804000000000 implements MigrationInterface {
  name = 'DefaultToOnlinePayment1804000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE organizations ALTER COLUMN billing_mode SET DEFAULT 'prepaid'
    `);

    await queryRunner.query(`
      UPDATE organizations
      SET billing_mode = 'prepaid'
      WHERE billing_mode = 'invoice'
        AND id NOT IN (
          SELECT DISTINCT organization_id FROM events WHERE billing_status = 'invoice'
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE organizations ALTER COLUMN billing_mode SET DEFAULT 'invoice'
    `);
    await queryRunner.query(`
      UPDATE organizations SET billing_mode = 'invoice' WHERE billing_mode = 'prepaid'
    `);
  }
}
