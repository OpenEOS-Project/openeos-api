import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Optionale Verweise, die auf einen Datensatz einer anderen Organisation
 * zeigen, werden geleert. Die API nimmt solche Verweise nicht mehr an
 * (common/utils/organization-references.ts); diese Migration raeumt
 * Altbestaende auf, damit Antworten nur Daten der eigenen Organisation
 * enthalten. Verweise innerhalb derselben Organisation bleiben unberuehrt.
 *
 * Nicht umkehrbar: die geleerten Verweise waren ungueltig.
 */
export class ClearCrossOrganizationReferences1842910000000 implements MigrationInterface {
  name = 'ClearCrossOrganizationReferences1842910000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Artikel: Pfand-Typ, Produktionsstandort
    await queryRunner.query(`
      UPDATE products p SET pfand_type_id = NULL
        FROM events e, pfand_types t
       WHERE e.id = p.event_id AND t.id = p.pfand_type_id
         AND t.organization_id <> e.organization_id`);
    await queryRunner.query(`
      UPDATE products p SET production_station_id = NULL
        FROM events e, production_stations s, events se
       WHERE e.id = p.event_id AND s.id = p.production_station_id
         AND se.id = s.event_id AND se.organization_id <> e.organization_id`);

    // Kategorien: uebergeordnete Kategorie, Produktionsstandort
    await queryRunner.query(`
      UPDATE categories c SET parent_id = NULL
        FROM events e, categories pc, events pe
       WHERE e.id = c.event_id AND pc.id = c.parent_id
         AND pe.id = pc.event_id AND pe.organization_id <> e.organization_id`);
    await queryRunner.query(`
      UPDATE categories c SET production_station_id = NULL
        FROM events e, production_stations s, events se
       WHERE e.id = c.event_id AND s.id = c.production_station_id
         AND se.id = s.event_id AND se.organization_id <> e.organization_id`);

    // Produktionsstandorte: Drucker
    await queryRunner.query(`
      UPDATE production_stations s SET printer_id = NULL
        FROM events e, printers p
       WHERE e.id = s.event_id AND p.id = s.printer_id
         AND p.organization_id <> e.organization_id`);

    // QR-Codes und Schichtplaene: Veranstaltung
    await queryRunner.query(`
      UPDATE qr_codes q SET event_id = NULL
        FROM events e
       WHERE e.id = q.event_id AND e.organization_id <> q.organization_id`);
    await queryRunner.query(`
      UPDATE shift_plans sp SET event_id = NULL
        FROM events e
       WHERE e.id = sp.event_id AND e.organization_id <> sp.organization_id`);
  }

  public async down(): Promise<void> {
    // Nichts zurueckzunehmen.
  }
}
