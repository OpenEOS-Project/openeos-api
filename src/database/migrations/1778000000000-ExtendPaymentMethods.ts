import { MigrationInterface, QueryRunner } from 'typeorm';

export class ExtendPaymentMethods1778000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "payment_method" ADD VALUE IF NOT EXISTS 'paypal'`);
    await queryRunner.query(`ALTER TYPE "payment_method" ADD VALUE IF NOT EXISTS 'google_pay'`);
    await queryRunner.query(`ALTER TYPE "payment_method" ADD VALUE IF NOT EXISTS 'apple_pay'`);
    const providerExists = await queryRunner.query(
      `SELECT 1 FROM pg_type WHERE typname = 'payment_provider'`,
    );
    if (providerExists.length > 0) {
      await queryRunner.query(`ALTER TYPE "payment_provider" ADD VALUE IF NOT EXISTS 'PAYPAL'`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Enum values cannot be removed in PostgreSQL
  }
}
