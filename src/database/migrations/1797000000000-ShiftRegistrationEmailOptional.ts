import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes the email column on shift_registrations nullable so admins can
 * add helpers manually without an email address.
 */
export class ShiftRegistrationEmailOptional1797000000000 implements MigrationInterface {
  name = 'ShiftRegistrationEmailOptional1797000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE shift_registrations
      ALTER COLUMN email DROP NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Prevent failure when rows with null email exist: blank them first.
    await queryRunner.query(`
      UPDATE shift_registrations SET email = '' WHERE email IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE shift_registrations
      ALTER COLUMN email SET NOT NULL
    `);
  }
}
