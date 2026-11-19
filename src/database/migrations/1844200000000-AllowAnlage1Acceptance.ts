import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Anlage 1 (Leistungsbeschreibung und Preisliste) wird bei Registrierung,
 * Buchung und erneuter Annahme als eigenes Dokument festgehalten. Die
 * Pruefregel aus CreateLegalAcceptances kannte nur `agb` und `avv`.
 */
export class AllowAnlage1Acceptance1844200000000 implements MigrationInterface {
  name = 'AllowAnlage1Acceptance1844200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE legal_acceptances DROP CONSTRAINT IF EXISTS "CHK_legal_acceptances_document"`,
    );
    await queryRunner.query(
      `ALTER TABLE legal_acceptances ADD CONSTRAINT "CHK_legal_acceptances_document" CHECK (document IN ('agb', 'avv', 'anlage1'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM legal_acceptances WHERE document = 'anlage1'`,
    );
    await queryRunner.query(
      `ALTER TABLE legal_acceptances DROP CONSTRAINT IF EXISTS "CHK_legal_acceptances_document"`,
    );
    await queryRunner.query(
      `ALTER TABLE legal_acceptances ADD CONSTRAINT "CHK_legal_acceptances_document" CHECK (document IN ('agb', 'avv'))`,
    );
  }
}
