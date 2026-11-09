import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import {
  CashPointClosing,
  Event,
  Order,
  OrderItem,
  Organization,
  Payment,
  PfandReturn,
  Product,
  Refund,
  WebhookDelivery,
  WebhookEndpoint,
} from '../../database/entities';
import { isOrdersOnly } from '../../common/utils/operating-mode.util';
import { EventPhaseService } from '../events/event-phase.service';
import {
  MONEY_ONLY_EVENT_TYPES,
  isWebhookEventType,
  type WebhookEventType,
} from './webhook-event-types';
import {
  closingData,
  envelope,
  eventData,
  orderData,
  paymentData,
  pfandReturnData,
  productData,
  refundData,
  type PayloadOptions,
} from './webhook-payloads';
import {
  OUTBOX_SETTLE_MS,
  WEBHOOKS_CONFIG,
  type WebhooksConfig,
} from './webhooks.config';

export interface OutboxRow {
  id: string;
  organization_id: string;
  event_type: string;
  resource_id: string;
  data: Record<string, unknown> | null;
  created_at: Date;
}

/** Inhalt eines Ereignisses; `data(guest)` je nach Einstellung des Endpunkts. */
export interface BuiltEvent {
  isTest: boolean;
  data: (includeGuestData: boolean) => Record<string, unknown>;
}

/**
 * Holt die Eintraege aus dem Postausgang (`webhook_outbox`, gefuellt von
 * den Datenbank-Triggern) und legt je passendem Endpunkt eine Zustellung
 * an. Abholen und Anlegen geschehen in einer Transaktion mit
 * `FOR UPDATE SKIP LOCKED`: mehrere Instanzen teilen sich die Arbeit, kein
 * Eintrag geht verloren oder wird doppelt verteilt.
 *
 * Der Inhalt entsteht hier, nicht im Trigger: er spiegelt den Stand beim
 * Abholen (wenige Sekunden nach der Aenderung) und steht dann fest — jeder
 * weitere Versuch sendet denselben Text mit derselben Ereignis-ID.
 */
@Injectable()
export class WebhookDispatcherService {
  private readonly logger = new Logger(WebhookDispatcherService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(WEBHOOKS_CONFIG) private readonly config: WebhooksConfig,
    private readonly eventPhase: EventPhaseService,
  ) {}

  /** Verteilt bis zu `limit` Eintraege; liefert die Zahl neuer Zustellungen. */
  async dispatchBatch(now: Date = new Date(), limit = 100): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const result = await manager.query<[OutboxRow[], number] | OutboxRow[]>(
        `DELETE FROM webhook_outbox
          WHERE id IN (
            SELECT id FROM webhook_outbox
             WHERE created_at <= $1
             ORDER BY id
             LIMIT $2
             FOR UPDATE SKIP LOCKED)
        RETURNING id, organization_id, event_type, resource_id, data, created_at`,
        [new Date(now.getTime() - OUTBOX_SETTLE_MS), limit],
      );
      // DELETE … RETURNING liefert bei Postgres [Zeilen, Anzahl].
      const claimed = (
        Array.isArray(result[0]) ? result[0] : result
      ) as OutboxRow[];
      if (claimed.length === 0) return 0;
      const rows = [...claimed].sort((a, b) => Number(a.id) - Number(b.id));

      const orgIds = [...new Set(rows.map((r) => r.organization_id))];
      const endpoints = await manager
        .getRepository(WebhookEndpoint)
        .createQueryBuilder('e')
        .where('e.organizationId IN (:...orgIds)', { orgIds })
        .andWhere('e.active = true')
        .getMany();
      const organizations = await manager.getRepository(Organization).find({
        where: orgIds.map((id) => ({ id })),
        select: { id: true, operatingMode: true },
      });
      const ordersOnly = new Map(
        organizations.map((o) => [o.id, isOrdersOnly(o)]),
      );

      let created = 0;
      for (const row of rows) {
        const type = row.event_type;
        if (!isWebhookEventType(type)) continue;
        const targets = endpoints.filter(
          (e) =>
            e.organizationId === row.organization_id &&
            e.eventTypes.includes(type),
        );
        if (targets.length === 0) continue;
        const noAmounts = ordersOnly.get(row.organization_id) ?? false;
        if (noAmounts && MONEY_ONLY_EVENT_TYPES.includes(type)) continue;

        let built: BuiltEvent | null;
        try {
          built = await this.build(manager, type, row, noAmounts);
        } catch (error) {
          this.logger.error(
            `Webhook ${type} ${row.resource_id}: payload failed (${(error as Error).message})`,
          );
          continue;
        }
        if (!built) continue;

        const eventId = randomUUID();
        const createdAt = new Date(row.created_at);
        const variants = new Map<boolean, string>();
        const body = (guest: boolean): string => {
          let text = variants.get(guest);
          if (text === undefined) {
            text = JSON.stringify(
              envelope(
                eventId,
                type,
                row.organization_id,
                createdAt,
                built.data(guest),
              ),
            );
            variants.set(guest, text);
          }
          return text;
        };

        for (const endpoint of targets) {
          if (built.isTest && !endpoint.includeTestOrders) continue;
          await manager.getRepository(WebhookDelivery).insert({
            endpointId: endpoint.id,
            organizationId: row.organization_id,
            eventId,
            eventType: type,
            payload: body(endpoint.includeGuestData),
            status: 'pending',
            attempts: 0,
            nextAttemptAt: now,
            manual: false,
          });
          created += 1;
        }
      }
      return created;
    });
  }

  /** Inhalt laden und abbilden; `null`, wenn es den Datensatz nicht mehr gibt. */
  async build(
    manager: EntityManager,
    type: WebhookEventType,
    row: Pick<OutboxRow, 'resource_id' | 'data' | 'organization_id'>,
    ordersOnly: boolean,
  ): Promise<BuiltEvent | null> {
    const id = row.resource_id;
    const extra = row.data ?? {};
    const opts = (guest: boolean): PayloadOptions => ({
      ordersOnly,
      includeGuestData: guest,
    });

    switch (type) {
      case 'order.created':
      case 'order.paid':
      case 'order.completed':
      case 'order.cancelled':
      case 'shop.order.created': {
        const order = await manager.findOne(Order, { where: { id } });
        if (!order || order.organizationId !== row.organization_id) return null;
        const items = await manager.find(OrderItem, { where: { orderId: id } });
        return {
          isTest: order.isTest,
          data: (guest) => ({ order: orderData(order, items, opts(guest)) }),
        };
      }
      case 'payment.created': {
        const payment = await manager.findOne(Payment, { where: { id } });
        if (!payment) return null;
        const order = await manager.findOne(Order, {
          where: { id: payment.orderId },
          select: {
            id: true,
            organizationId: true,
            orderNumber: true,
            eventId: true,
            isTest: true,
          },
        });
        if (!order || order.organizationId !== row.organization_id) return null;
        return {
          isTest: order.isTest,
          data: () => ({ payment: paymentData(payment, order) }),
        };
      }
      case 'refund.created': {
        const refund = await manager.findOne(Refund, {
          where: { id },
          relations: { items: true },
        });
        if (!refund || refund.organizationId !== row.organization_id) {
          return null;
        }
        const order = await manager.findOne(Order, {
          where: { id: refund.orderId },
          select: { id: true, orderNumber: true },
        });
        return {
          isTest: refund.isTest || refund.status === 'test',
          data: () => ({ refund: refundData(refund, order) }),
        };
      }
      case 'pfand_return.created': {
        const pfandReturn = await manager.findOne(PfandReturn, {
          where: { id },
        });
        if (
          !pfandReturn ||
          pfandReturn.organizationId !== row.organization_id
        ) {
          return null;
        }
        return {
          isTest: pfandReturn.isTest,
          data: (guest) => ({
            pfandReturn: pfandReturnData(pfandReturn, opts(guest)),
          }),
        };
      }
      case 'cash_point_closing.created': {
        const closing = await manager.findOne(CashPointClosing, {
          where: { id },
        });
        if (!closing || closing.organizationId !== row.organization_id) {
          return null;
        }
        return {
          isTest: false,
          data: () => ({ closing: closingData(closing) }),
        };
      }
      case 'event.activated':
      case 'event.phase_changed': {
        const event = await manager.findOne(Event, { where: { id } });
        if (!event || event.organizationId !== row.organization_id) return null;
        let phase = typeof extra.phase === 'string' ? extra.phase : null;
        if (!phase) {
          try {
            phase = (await this.eventPhase.resolve(event)).phase;
          } catch {
            phase = null;
          }
        }
        const base = eventData(event, phase);
        return {
          isTest: false,
          data: () =>
            type === 'event.phase_changed'
              ? {
                  event: base,
                  previousPhase:
                    typeof extra.previousPhase === 'string'
                      ? extra.previousPhase
                      : null,
                  phase,
                }
              : { event: base },
        };
      }
      case 'product.updated': {
        const product = await manager.findOne(Product, {
          where: { id },
          withDeleted: true,
        });
        if (!product) return null;
        const changed = Array.isArray(extra.changed)
          ? (extra.changed as unknown[]).filter(
              (c): c is string => typeof c === 'string',
            )
          : [];
        return {
          isTest: false,
          data: (guest) => ({
            product: productData(product, opts(guest)),
            changed: ordersOnly
              ? changed.filter((c) => c !== 'price' && c !== 'taxRate')
              : changed,
          }),
        };
      }
    }
  }

  /** Fuer Instanzen mit ausgeschalteten Webhooks: nichts anhaeufen. */
  async purgeOutbox(olderThan: Date): Promise<number> {
    const result = await this.dataSource.query<[unknown[], number]>(
      `DELETE FROM webhook_outbox WHERE created_at < $1`,
      [olderThan],
    );
    return Array.isArray(result) ? Number(result[1] ?? 0) : 0;
  }

  get settings(): WebhooksConfig {
    return this.config;
  }
}
