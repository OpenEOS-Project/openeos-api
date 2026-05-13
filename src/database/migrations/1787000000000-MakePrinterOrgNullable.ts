import { MigrationInterface, QueryRunner } from 'typeorm';

export class MakePrinterOrgNullable1787000000000 implements MigrationInterface {
  name = 'MakePrinterOrgNullable1787000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "printers" ALTER COLUMN "organization_id" DROP NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "printers" ALTER COLUMN "organization_id" SET NOT NULL`);
  }
}
