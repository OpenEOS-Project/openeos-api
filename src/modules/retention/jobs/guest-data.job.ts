import { daysBefore } from '../retention.config';
import { affected } from '../retention-sql';
import type { RetentionJob, RetentionRunContext } from '../retention.types';

/**
 * Personenbezogene Angaben von Gaesten: Name, Telefon, E-Mail und
 * Anmerkungen in Bestellungen, Shop-Checkouts und Bestellungen am Tisch,
 * `RETENTION_GUEST_DATA_DAYS` (30) Tage nach dem Ende der Veranstaltung.
 *
 * Die Bestellung selbst bleibt (Berichte, Steuerarchiv) — nur die Felder
 * mit Personenbezug werden geleert. Ohne Enddatum der Veranstaltung zaehlt
 * der Bestellzeitpunkt, offene Bestellungen bleiben dann unangetastet.
 */
export class GuestDataJob implements RetentionJob {
  readonly category = 'guest_data' as const;

  async run(ctx: RetentionRunContext): Promise<void> {
    const cutoff = daysBefore(ctx.now, ctx.config.guestDataDays);
    const { manager } = ctx;

    // Bestellungen, deren Veranstaltung (bzw. Bestellzeitpunkt) lange genug
    // zurueckliegt.
    const due = `o.created_at < $1
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.id = o.event_id
                       AND e.end_date IS NOT NULL AND e.end_date >= $1)
      AND (o.status IN ('completed', 'cancelled')
           OR EXISTS (SELECT 1 FROM events e WHERE e.id = o.event_id
                       AND e.end_date IS NOT NULL))`;

    ctx.removed(
      'orderItemNotesCleared',
      await affected(
        manager,
        `UPDATE order_items oi SET notes = NULL
           FROM orders o
          WHERE oi.order_id = o.id AND oi.notes IS NOT NULL
            AND o.source IN ('online', 'qr_order') AND ${due}`,
        [cutoff],
      ),
    );

    ctx.removed(
      'ordersAnonymised',
      await affected(
        manager,
        `UPDATE orders o
            SET customer_name = NULL, customer_phone = NULL, notes = NULL
          WHERE (o.customer_name IS NOT NULL OR o.customer_phone IS NOT NULL
                 OR o.notes IS NOT NULL)
            AND ${due}`,
        [cutoff],
      ),
    );

    ctx.removed(
      'shopCheckoutsAnonymised',
      await affected(
        manager,
        `UPDATE shop_checkouts sc SET email = '', customer_name = NULL
          WHERE (sc.email <> '' OR sc.customer_name IS NOT NULL)
            AND sc.created_at < $1
            AND NOT EXISTS (SELECT 1 FROM events e WHERE e.id = sc.event_id
                             AND e.end_date IS NOT NULL AND e.end_date >= $1)`,
        [cutoff],
      ),
    );

    // Sitzungen der Bestellung am Tisch: Name und Warenkorb (Anmerkungen).
    ctx.removed(
      'orderSessionsDeleted',
      await affected(
        manager,
        `DELETE FROM online_order_sessions s
          WHERE s.expires_at < $1 AND s.created_at < $1`,
        [cutoff],
      ),
    );

    // Druckauftraege tragen den Namen des Gastes im Bon.
    ctx.removed(
      'printJobsDeleted',
      await affected(
        manager,
        `DELETE FROM print_jobs pj
          WHERE pj.created_at < $1 AND pj.status IN ('completed', 'failed')`,
        [cutoff],
      ),
    );
  }
}
