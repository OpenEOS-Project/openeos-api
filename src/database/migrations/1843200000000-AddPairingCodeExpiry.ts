import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kopplungscodes mit Ablaufzeit, acht Ziffern und Herkunftsadresse (als
 * Hash) fuer die Obergrenze wartender Geraete. Bestehende Codes gelten ab
 * jetzt noch 15 Minuten.
 */
export class AddPairingCodeExpiry1843200000000 implements MigrationInterface {
  name = 'AddPairingCodeExpiry1843200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "devices" ALTER COLUMN "verification_code" TYPE varchar(8)`,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "verification_code_expires_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "pairing_ip_hash" varchar(64)`,
    );
    await queryRunner.query(
      `UPDATE "devices" SET "verification_code_expires_at" = now() + interval '15 minutes' WHERE "status" = 'pending' AND "verification_code" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_devices_pending_code" ON "devices" ("verification_code") WHERE "status" = 'pending'`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_devices_pending_ip" ON "devices" ("pairing_ip_hash") WHERE "status" = 'pending'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_devices_pending_ip"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_devices_pending_code"`);
    await queryRunner.query(
      `ALTER TABLE "devices" DROP COLUMN IF EXISTS "pairing_ip_hash"`,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" DROP COLUMN IF EXISTS "verification_code_expires_at"`,
    );
    await queryRunner.query(
      `UPDATE "devices" SET "verification_code" = NULL WHERE length("verification_code") > 6`,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" ALTER COLUMN "verification_code" TYPE varchar(6)`,
    );
  }
}
