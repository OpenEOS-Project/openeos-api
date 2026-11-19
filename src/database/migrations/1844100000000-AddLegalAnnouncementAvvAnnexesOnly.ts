import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ankuendigungen: vom AVV aendern sich nur die Anhaenge B/C (Verfahren
 * nach AVV Ziffer 6.3 statt Zustimmung nach 12.4).
 */
export class AddLegalAnnouncementAvvAnnexesOnly1844100000000 implements MigrationInterface {
  name = 'AddLegalAnnouncementAvvAnnexesOnly1844100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE legal_announcements ADD COLUMN IF NOT EXISTS avv_annexes_only boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE legal_announcements DROP COLUMN IF EXISTS avv_annexes_only`,
    );
  }
}
