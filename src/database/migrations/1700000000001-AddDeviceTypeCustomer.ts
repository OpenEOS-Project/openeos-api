import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDeviceTypeCustomer1700000000001 implements MigrationInterface {
  name = 'AddDeviceTypeCustomer1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "device_type" ADD VALUE IF NOT EXISTS 'display_customer'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Note: PostgreSQL doesn't support removing enum values directly
    // The value will remain in the enum but won't be used
  }
}
