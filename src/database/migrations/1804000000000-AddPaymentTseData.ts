import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TSE (Technische Sicherheitseinrichtung) support per KassenSichV. Signed
 * transaction data (signature, transaction number, QR payload) is stored
 * per-payment rather than folded into the existing `metadata` jsonb column,
 * since it is legally significant record-keeping, not free-form provider
 * metadata.
 */
export class AddPaymentTseData1804000000000 implements MigrationInterface {
  name = 'AddPaymentTseData1804000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "tse_data" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payments" DROP COLUMN IF EXISTS "tse_data"`,
    );
  }
}
