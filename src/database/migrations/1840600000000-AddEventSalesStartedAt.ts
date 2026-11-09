import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phasen einer Veranstaltung (Geplant – Aktiv – Beendet, 2026-11-08):
 * `events.sales_started_at` haelt fest, wann das Verkaufsfenster begonnen
 * hat und die Testbestellungen aus „Geplant“ entfernt wurden. Die Phase
 * selbst wird nicht gespeichert, sie folgt aus Status, Abrechnung, Datum
 * und Uhrzeit.
 *
 * Dazu der Protokollwert `event_dates_override`: der Support verschiebt
 * eine Veranstaltung nach Beginn des Verkaufsfensters (mit Grund).
 *
 * Bestand: Veranstaltungen, die bereits laufen oder vorbei sind, erledigt
 * der Uebergangslauf beim ersten Durchgang (dort gibt es keine
 * Testbestellungen — die wurden beim Aktivieren geloescht). Echte
 * Bestellungen werden nie angefasst.
 */
export class AddEventSalesStartedAt1840600000000 implements MigrationInterface {
  name = 'AddEventSalesStartedAt1840600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE events ADD COLUMN IF NOT EXISTS sales_started_at timestamp with time zone NULL`,
    );
    await queryRunner.commitTransaction();
    await queryRunner.query(
      `ALTER TYPE "admin_action" ADD VALUE IF NOT EXISTS 'event_dates_override'`,
    );
    await queryRunner.startTransaction();
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Enum-Werte lassen sich in Postgres nicht entfernen.
    await queryRunner.query(
      `ALTER TABLE events DROP COLUMN IF EXISTS sales_started_at`,
    );
  }
}
