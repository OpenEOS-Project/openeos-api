import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Idempotente Bestellanlage an der Kasse.
 *
 * Die Kasse schickt je Anlageversuch eine `clientRequestId` (UUID) mit.
 * Kommt dieselbe Anfrage erneut an (Netzabbruch, Doppelklick, „Erneut
 * speichern“ nach einer Kartenzahlung), liefert die API die bereits
 * angelegte Bestellung zurueck statt eine zweite anzulegen. Der eindeutige
 * Index je Organisation sichert das auch bei gleichzeitigen Anfragen ab.
 *
 * Bestandsbestellungen behalten NULL; der Index gilt nur fuer gesetzte Werte.
 */
export class AddOrderClientRequestId1814000000000 implements MigrationInterface {
  name = 'AddOrderClientRequestId1814000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE orders ADD COLUMN client_request_id uuid NULL`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_orders_org_client_request"
        ON orders (organization_id, client_request_id)
        WHERE client_request_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_orders_org_client_request"`,
    );
    await queryRunner.query(
      `ALTER TABLE orders DROP COLUMN IF EXISTS client_request_id`,
    );
  }
}
