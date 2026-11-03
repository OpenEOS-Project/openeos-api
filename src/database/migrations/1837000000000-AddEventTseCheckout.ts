import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cloud-TSE „All inclusive“ beim Freischalten einer Veranstaltung
 * (tse-swissbit-plan.md §8.3, Entscheidung 2026-11-03). Nur Erweiterungen:
 *
 * - `events.tse_included`: Gehoert die Cloud-TSE zu dieser Freischaltung?
 *   `true` bei „Alle Funktionen“ in Deutschland (bzw. Bestand mit „Ja“ im
 *   Bezahldialog), `false` bei Bestand mit „Nein“, `NULL` wenn die Frage
 *   nicht anfaellt (Bargeldlos, Nur Bons, andere Laender, Server ohne TSE).
 * - `events.tse_surcharge`: der dabei berechnete TSE-Zuschlag je
 *   Veranstaltung (`TSE_EVENT_SURCHARGE_EUR`, derzeit 0 = inklusive). Steckt
 *   in `price_charged` und wird bei einer kostenlosen Stornierung mit
 *   erstattet.
 */
export class AddEventTseCheckout1837000000000 implements MigrationInterface {
  name = 'AddEventTseCheckout1837000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE events ADD COLUMN IF NOT EXISTS tse_included boolean NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE events ADD COLUMN IF NOT EXISTS tse_surcharge numeric(10,2) NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE events DROP COLUMN IF EXISTS tse_surcharge`,
    );
    await queryRunner.query(
      `ALTER TABLE events DROP COLUMN IF EXISTS tse_included`,
    );
  }
}
