import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Umriss eines Bereichs (nicht rechteckige Raeume).
 *
 * Eigene Spalte statt eines Eintrags in `decor`: der Umriss gehoert zum
 * Bereich selbst (genau einer, `NULL` = Rechteck der ganzen Karte) und ist
 * kein Deko-Element. Waende als Linienzug und Zonen liegen dagegen als
 * neue Elementtypen in `decor` (jsonb) und brauchen keine Migration.
 *
 * down: entfernt neben der Spalte auch die neuen Elemente (Eintraege mit
 * `points`) aus `decor`, weil aeltere Versionen nur Rechtecke lesen.
 */
export class AddTableAreaOutline1817000000000 implements MigrationInterface {
  name = 'AddTableAreaOutline1817000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "table_areas" ADD COLUMN IF NOT EXISTS "outline" jsonb NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "table_areas" SET "decor" = COALESCE((
        SELECT jsonb_agg(e) FROM jsonb_array_elements("decor") e
        WHERE NOT (e ? 'points')
      ), '[]'::jsonb)
      WHERE jsonb_typeof("decor") = 'array'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements("decor") e WHERE e ? 'points')
    `);
    await queryRunner.query(
      `ALTER TABLE "table_areas" DROP COLUMN IF EXISTS "outline"`,
    );
  }
}
