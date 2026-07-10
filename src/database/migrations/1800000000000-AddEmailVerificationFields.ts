import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds token fields needed to verify a user's email address on registration.
 * Existing accounts are grandfathered in as verified so nobody who already
 * has an account gets locked out of login once verification is enforced.
 */
export class AddEmailVerificationFields1800000000000 implements MigrationInterface {
  name = 'AddEmailVerificationFields1800000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS email_verification_token varchar(255),
      ADD COLUMN IF NOT EXISTS email_verification_expires_at timestamptz
    `);

    await queryRunner.query(`
      UPDATE users SET email_verified_at = now() WHERE email_verified_at IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
      DROP COLUMN IF EXISTS email_verification_token,
      DROP COLUMN IF EXISTS email_verification_expires_at
    `);
  }
}
