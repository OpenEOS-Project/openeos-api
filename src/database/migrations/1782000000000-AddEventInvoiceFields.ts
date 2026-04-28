import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEventInvoiceFields1782000000000 implements MigrationInterface {
  name = 'AddEventInvoiceFields1782000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "invoiced_at" TIMESTAMP WITH TIME ZONE NULL`);
    await queryRunner.query(`ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "invoiced_by" UUID NULL`);
    await queryRunner.query(`ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "invoice_note" TEXT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "events" DROP COLUMN IF EXISTS "invoice_note"`);
    await queryRunner.query(`ALTER TABLE "events" DROP COLUMN IF EXISTS "invoiced_by"`);
    await queryRunner.query(`ALTER TABLE "events" DROP COLUMN IF EXISTS "invoiced_at"`);
  }
}
