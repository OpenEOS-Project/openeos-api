import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCashDrawerToPrinters1776000000000 implements MigrationInterface {
  name = 'AddCashDrawerToPrinters1776000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "printers" ADD COLUMN IF NOT EXISTS "has_cash_drawer" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "printers" DROP COLUMN IF EXISTS "has_cash_drawer"`);
  }
}
