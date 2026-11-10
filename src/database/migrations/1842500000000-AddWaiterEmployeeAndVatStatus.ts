import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Steuerberater 2026-11-10 (Fragen 3–5 und 9):
 *
 * - `waiters.is_employee` „Arbeitnehmer (Lohnkonto)“, Standard aus. Nur mit
 *   diesem Kennzeichen ist Trinkgeld `TrinkgeldAN` (kein Entgelt) und darf
 *   Kartentrinkgeld bar ausgezahlt werden; sonst `TrinkgeldAG` mit dem Satz
 *   der Hauptleistung. Ersetzt die Organisations-Einstellung
 *   `settings.dsfinvk.tipRecipient` fuer neue Vorgaenge. Bewusst keine
 *   Datenuebernahme: „employee“ auf Organisationsebene hiess bisher „alle
 *   Helfer“ — Ehrenamtliche sind laut Steuerberater aber keine
 *   Arbeitnehmer. Angestellte Bedienungen markiert der Verein selbst. Alte
 *   Vorgaenge ohne Kennzeichen bleiben im Export, wie sie signiert wurden.
 * - Protokoll `vat_status_changed` (Kleinunternehmer ↔ steuerpflichtig nach
 *   Kassenabschluss).
 */
export class AddWaiterEmployeeAndVatStatus1842500000000 implements MigrationInterface {
  name = 'AddWaiterEmployeeAndVatStatus1842500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE waiters ADD COLUMN IF NOT EXISTS is_employee boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.commitTransaction();
    await queryRunner.query(
      `ALTER TYPE "admin_action" ADD VALUE IF NOT EXISTS 'vat_status_changed'`,
    );
    await queryRunner.startTransaction();
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE waiters DROP COLUMN IF EXISTS is_employee`,
    );
  }
}
