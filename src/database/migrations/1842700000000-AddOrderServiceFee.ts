import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Servicegebuehr des Shops als eigene Leistung der Bestellung: Betrag
 * (brutto) und Steuersatz als Schnappschuss beim Bezahlen. Bisher stand die
 * Gebuehr nur in `total` (und in der Notiz); Kassenbeleg und DSFinV-K
 * schlugen sie dem Steuersatz mit dem groessten Warenanteil zu.
 *
 * Kein Nachtrag fuer bestehende Bestellungen: deren signierte Belege
 * enthalten die Gebuehr bereits im groessten Satz, ein Nachdruck soll
 * dazu passen.
 */
export class AddOrderServiceFee1842700000000 implements MigrationInterface {
  name = 'AddOrderServiceFee1842700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE orders
        ADD COLUMN IF NOT EXISTS service_fee numeric(10,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS service_fee_tax_rate numeric(5,2) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE orders
        DROP COLUMN IF EXISTS service_fee_tax_rate,
        DROP COLUMN IF EXISTS service_fee
    `);
  }
}
