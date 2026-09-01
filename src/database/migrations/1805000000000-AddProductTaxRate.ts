import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Umsatzsteuersatz je Produkt.
 *
 * Standard ist 0 — steuerfrei. Das ist hier nicht die vorsichtige, sondern
 * die richtige Annahme: die Organisationen sind ueberwiegend Vereine, und
 * bis zum Freischalten der Steuerpflicht wurde ohnehin ohne Steuer
 * gerechnet. Ein Bestandsprodukt nachtraeglich auf 19 % zu setzen wuerde
 * Betraege behaupten, die nie erhoben wurden.
 */
export class AddProductTaxRate1805000000000 implements MigrationInterface {
  name = 'AddProductTaxRate1805000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE products
      ADD COLUMN IF NOT EXISTS tax_rate numeric(5,2) NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE products DROP COLUMN IF EXISTS tax_rate`);
  }
}
