import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { StockMovementType } from '../../database/entities/stock-movement.entity';
import { GatewayService } from '../gateway/gateway.service';

/** Was beim Aktivieren an Testbuchungen entfernt wurde. */
export interface TestOrderPurgeResult {
  organizationId: string;
  eventId: string;
  deletedOrderIds: string[];
  deletedPfandReturns: number;
  /** Produkte, deren Bestand zurueckgebucht wurde. */
  restockedProducts: {
    productId: string;
    quantity: number;
    quantityBefore: number;
    quantityAfter: number;
  }[];
}

/** `reference_type` der Korrekturbuchung im Bestandsjournal. */
export const TEST_ORDER_CLEANUP_REFERENCE = 'test_order_cleanup';

/**
 * Loescht beim Aktivieren einer Veranstaltung alles, was im Testmodus
 * gebucht wurde (Kennzeichen `is_test` an Bestellungen und
 * Pfand-Rueckgaben), samt abhaengiger Daten.
 *
 * Laeuft im EntityManager der Aktivierung: schlaegt ein Schritt fehl, rollt
 * die Transaktion alles zurueck, auch den Statuswechsel. Ein zweiter Aufruf
 * findet nichts mehr und aendert nichts (idempotent).
 *
 * Abhaengige Daten:
 * - Positionen, Zahlungen und Teilzahlungen haengen per ON DELETE CASCADE
 *   an der Bestellung.
 * - Druckauftraege wuerden per SET NULL verwaisen (und ein noch
 *   wartender Testbon kaeme spaeter aus dem Drucker) — sie werden
 *   ausdruecklich geloescht, ebenso die verknuepften Shop-Checkouts.
 * - Bestandsbuchungen mit Bezug auf die Bestellungen werden geloescht und
 *   der Bestand zurueckgebucht (siehe `restoreStock`).
 * - Bestell- und Abholnummern ergeben sich aus dem Hoechstwert der
 *   vorhandenen Bestellungen; ohne die Testbestellungen beginnen sie neu.
 */
@Injectable()
export class TestOrderCleanupService {
  private readonly logger = new Logger(TestOrderCleanupService.name);

  constructor(
    @Inject(forwardRef(() => GatewayService))
    private readonly gatewayService: GatewayService,
  ) {}

  async purge(
    manager: EntityManager,
    organizationId: string,
    eventId: string,
  ): Promise<TestOrderPurgeResult> {
    const orderRows = await manager.query<{ id: string }[]>(
      `SELECT id FROM orders
       WHERE event_id = $1 AND organization_id = $2 AND is_test
       FOR UPDATE`,
      [eventId, organizationId],
    );
    const orderIds = orderRows.map((row) => row.id);

    const restockedProducts = orderIds.length
      ? await this.restoreStock(manager, organizationId, eventId)
      : [];

    if (orderIds.length) {
      await manager.query(
        `DELETE FROM stock_movements
         WHERE event_id = $1 AND reference_type = 'order'
           AND reference_id = ANY($2::uuid[])`,
        [eventId, orderIds],
      );
      await manager.query(
        `DELETE FROM print_jobs
         WHERE organization_id = $1
           AND (order_id = ANY($2::uuid[])
             OR order_item_id IN (
               SELECT id FROM order_items WHERE order_id = ANY($2::uuid[])
             ))`,
        [organizationId, orderIds],
      );
      await manager.query(
        `DELETE FROM shop_checkouts
         WHERE organization_id = $1 AND event_id = $2
           AND order_id = ANY($3::uuid[])`,
        [organizationId, eventId, orderIds],
      );
      // Positionen, Zahlungen und Teilzahlungen folgen per CASCADE.
      await manager.query(
        `DELETE FROM orders
         WHERE organization_id = $1 AND event_id = $2
           AND id = ANY($3::uuid[])`,
        [organizationId, eventId, orderIds],
      );
    }

    // UPDATE/DELETE liefern ueber TypeORM [Zeilen, Anzahl]; in einer CTE
    // verpackt kommt wie bei SELECT nur die Zeilenliste zurueck.
    const pfandRows = await manager.query<{ id: string }[]>(
      `WITH deleted AS (
         DELETE FROM pfand_returns
         WHERE organization_id = $1 AND event_id = $2 AND is_test
         RETURNING id
       )
       SELECT id FROM deleted`,
      [organizationId, eventId],
    );

    return {
      organizationId,
      eventId,
      deletedOrderIds: orderIds,
      deletedPfandReturns: pfandRows.length,
      restockedProducts,
    };
  }

  /**
   * Bucht zurueck, was die Testbestellungen vom Bestand abgezogen haben.
   *
   * Nicht aus dem Bestandsjournal: die Kasse zieht beim Anlegen ab, ohne
   * eine Buchung zu schreiben. Massgeblich ist deshalb die Position selbst —
   * jede nicht stornierte Position hat ihre (ggf. geaenderte) Menge
   * abgezogen, eine stornierte hat sie beim Stornieren zurueckgegeben.
   *
   * Eine Inventur nach der Testbestellung hat deren Wirkung bereits
   * ausgeglichen (gezaehlt wird, was physisch da ist). Positionen, die vor
   * der letzten Inventur des Produkts angelegt wurden, zaehlen daher nicht.
   * Nur Produkte mit Bestandsfuehrung; jede Korrektur steht als
   * `adjustment_plus` im Journal.
   */
  private async restoreStock(
    manager: EntityManager,
    organizationId: string,
    eventId: string,
  ): Promise<TestOrderPurgeResult['restockedProducts']> {
    const rows = await manager.query<TestOrderPurgeResult['restockedProducts']>(
      `WITH last_count AS (
         SELECT product_id, MAX(created_at) AS counted_at
         FROM stock_movements
         WHERE event_id = $1 AND type = $3
         GROUP BY product_id
       ), restore AS (
         SELECT oi.product_id, SUM(oi.quantity)::int AS quantity
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         LEFT JOIN last_count lc ON lc.product_id = oi.product_id
         WHERE o.event_id = $1 AND o.organization_id = $2 AND o.is_test
           AND oi.status <> 'cancelled'
           AND (lc.counted_at IS NULL OR oi.created_at > lc.counted_at)
         GROUP BY oi.product_id
       ), restocked AS (
         UPDATE products p
         SET stock_quantity = p.stock_quantity + r.quantity,
             updated_at = now()
         FROM restore r
         WHERE p.id = r.product_id AND p.event_id = $1
           AND p.track_inventory AND r.quantity > 0
         RETURNING p.id AS "productId", r.quantity AS "quantity",
                   p.stock_quantity - r.quantity AS "quantityBefore",
                   p.stock_quantity AS "quantityAfter"
       )
       SELECT * FROM restocked ORDER BY "productId"`,
      [eventId, organizationId, StockMovementType.INVENTORY_COUNT],
    );

    for (const row of rows) {
      await manager.query(
        `INSERT INTO stock_movements
           (event_id, product_id, type, quantity, quantity_before,
            quantity_after, reference_type, reference_id, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $1, $8)`,
        [
          eventId,
          row.productId,
          StockMovementType.ADJUSTMENT_PLUS,
          row.quantity,
          row.quantityBefore,
          row.quantityAfter,
          TEST_ORDER_CLEANUP_REFERENCE,
          'Testbestellungen beim Aktivieren gelöscht',
        ],
      );
    }

    return rows;
  }

  /**
   * Nach dem Commit: Kassen und Stationen laden ihre Listen neu. Bewusst
   * ueber Ereignisse, die die Geraete schon verstehen — eine Bestellung
   * „aendert“ sich (sie ist weg), Menue und Tische sind neu zu laden
   * (Bestaende, Tischstatus).
   */
  notify(result: TestOrderPurgeResult): void {
    const { organizationId, eventId } = result;
    if (!result.deletedOrderIds.length && !result.deletedPfandReturns) return;

    for (const orderId of result.deletedOrderIds) {
      this.gatewayService.notifyOrderUpdated(organizationId, eventId, orderId, {
        deleted: true,
        reason: 'test-orders-deleted',
      });
    }
    this.gatewayService.notifyMenuRefresh(
      organizationId,
      eventId,
      'event-settings',
    );
    this.gatewayService.notifyTablesUpdated(organizationId);

    this.logger.log(
      `Test data deleted on activation of event ${eventId}: ${result.deletedOrderIds.length} orders, ${result.deletedPfandReturns} deposit returns, stock restored for ${result.restockedProducts.length} products`,
    );
  }
}
