import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Pfand mit Umsatzsteuer (openeos-web#116, Entscheidung 2026-11-09).
 *
 * Pfand gehoert zum Entgelt (Abschn. 10.1 Abs. 8 UStAE), die Rueckgabe
 * mindert es (§ 17 UStG). Jede Pfandart bekommt deshalb einen Steuersatz
 * (`pfand_types.vat_rate`, Standard 19 %), und jede Buchung haelt ihren
 * Satz fest:
 *
 * - `order_items.deposit_tax_rate`: Satz des Pfands der Position beim
 *   Verkauf. NULL = Bestand von vor der Umstellung: Pfand nicht steuerbar
 *   (0-%-Slot), so wie es damals auf Bon, TSE und im Bericht stand.
 * - `refund_items.deposit_tax_rate`: dasselbe fuer den Gegenbeleg.
 * - `pfand_returns.return_number` (Belegnummer `P-JJJJMMTT-NNNN`) und
 *   `tax_lines` (MwSt je Satz, negativ). Die Saetze je Position stehen in
 *   `lines[].vatRate`; fehlt er (Bestand), gilt 0 %.
 *
 * Bestehende Pfandarten bekommen 19 %. Das wirkt nur auf neue Buchungen
 * steuerpflichtiger Organisationen (`settings.vatExempt === false`);
 * Kleinunternehmer und steuerbefreite Vereine weisen weiter keine MwSt aus.
 * Alte Bestellungen, Erstattungen und Auszahlungen werden nicht angefasst.
 */
export class AddPfandVatRate1840800000000 implements MigrationInterface {
  name = 'AddPfandVatRate1840800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE pfand_types ADD COLUMN IF NOT EXISTS vat_rate numeric(5,2) NOT NULL DEFAULT 19`,
    );
    await queryRunner.query(
      `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS deposit_tax_rate numeric(5,2) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE refund_items ADD COLUMN IF NOT EXISTS deposit_tax_rate numeric(5,2) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE pfand_returns ADD COLUMN IF NOT EXISTS return_number varchar(50) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE pfand_returns ADD COLUMN IF NOT EXISTS tax_lines jsonb NOT NULL DEFAULT '[]'`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_pfand_returns_org_number" ON pfand_returns (organization_id, return_number)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_pfand_returns_org_number"`,
    );
    await queryRunner.query(
      `ALTER TABLE pfand_returns DROP COLUMN IF EXISTS tax_lines`,
    );
    await queryRunner.query(
      `ALTER TABLE pfand_returns DROP COLUMN IF EXISTS return_number`,
    );
    await queryRunner.query(
      `ALTER TABLE refund_items DROP COLUMN IF EXISTS deposit_tax_rate`,
    );
    await queryRunner.query(
      `ALTER TABLE order_items DROP COLUMN IF EXISTS deposit_tax_rate`,
    );
    await queryRunner.query(
      `ALTER TABLE pfand_types DROP COLUMN IF EXISTS vat_rate`,
    );
  }
}
