import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserOrganizationPin1772000000000 implements MigrationInterface {
  name = 'AddUserOrganizationPin1772000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE user_organizations ADD COLUMN "pin" varchar(255) DEFAULT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE user_organizations DROP COLUMN "pin"`,
    );
  }
}
