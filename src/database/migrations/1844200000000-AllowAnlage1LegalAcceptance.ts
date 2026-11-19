import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Anlage 1 (Leistungsbeschreibung und Preisliste) wird seit 1.8 bei
 * Registrierung, Buchung und erneuter Annahme mitprotokolliert. Der
 * Check-Constraint aus CreateLegalAcceptances kannte nur 'agb' und 'avv',
 * dadurch schlug jede Registrierung mit 500 fehl.
 */
export class AllowAnlage1LegalAcceptance1844200000000 implements MigrationInterface {
  name = 'AllowAnlage1LegalAcceptance1844200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE legal_acceptances DROP CONSTRAINT IF EXISTS "CHK_legal_acceptances_document"`,
    );
    await queryRunner.query(
      `ALTER TABLE legal_acceptances ADD CONSTRAINT "CHK_legal_acceptances_document" CHECK (document IN ('agb', 'avv', 'anlage1'))`,
    );
  }

  // Angenommene Fassungen sind Nachweise und werden beim Zurückrollen nicht
  // gelöscht; der alte Constraint gilt dann nur für neue Zeilen.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE legal_acceptances DROP CONSTRAINT IF EXISTS "CHK_legal_acceptances_document"`,
    );
    await queryRunner.query(
      `ALTER TABLE legal_acceptances ADD CONSTRAINT "CHK_legal_acceptances_document" CHECK (document IN ('agb', 'avv')) NOT VALID`,
    );
  }
}
