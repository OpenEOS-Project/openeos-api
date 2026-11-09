import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  AdminAction,
  AdminAuditLog,
  SYSTEM_AUDIT_IP,
} from '../../database/entities/admin-audit-log.entity';
import { OrderEvent } from '../../database/entities/order-event.entity';
import { GatewayService } from '../gateway/gateway.service';
import { rowsOf } from '../tse/tse-sql.util';
import type { Operator } from './waiter-operator';

/** Wer uebergibt (Kasse: Bedienung/Mitglied; Verwaltung: Benutzer). */
export interface TransferActor {
  operator?: Operator | null;
  userId?: string | null;
  deviceId?: string | null;
  /** Verwaltung: Admin bzw. Recht „Bedienungen“ (darf alles uebergeben). */
  admin?: boolean;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface TransferResult {
  orderIds: string[];
  toWaiter: {
    id: string;
    name: string;
    shortName: string | null;
    color: string | null;
  };
  fromWaiterIds: (string | null)[];
  eventId: string | null;
  tableNumber: string | null;
}

interface OpenOrderRow {
  id: string;
  event_id: string | null;
  waiter_id: string | null;
  table_id: string | null;
  table_number: string | null;
}

/** Offen = unbezahlt bzw. teilbezahlt, weder storniert noch abgeschlossen. */
const OPEN_ORDER_SQL = `o.status NOT IN ('cancelled', 'completed')
  AND o.payment_status IN ('unpaid', 'partly_paid')
  AND o.closed_without_payment_at IS NULL`;

function invalid(message: string, params?: Record<string, unknown>) {
  return new BadRequestException({
    code: ErrorCodes.VALIDATION_ERROR,
    reason: ErrorReasons.WAITER_TRANSFER_INVALID,
    message,
    params,
  });
}

/**
 * Tischuebergabe (bedienungen-plan.md §5, Entscheidung 7, in den MVP
 * gezogen): eine offene Bestellung — auf Wunsch alle offenen Bestellungen
 * desselben Tisches derselben Bedienung — bekommt eine neue
 * verantwortliche Bedienung (`orders.waiter_id`). Jede Uebergabe steht im
 * Verlauf der Bestellung (`order_events`, Typ `transferred`, nur IDs, keine
 * Namen) und geht als Echtzeit-Ereignis `orderTransferred` an die Geraete.
 */
@Injectable()
export class WaiterTransferService {
  private readonly logger = new Logger(WaiterTransferService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Optional() private readonly gateway?: GatewayService,
  ) {}

  /** An der Kasse: eine Bestellung (bzw. ihren Tisch) uebergeben. */
  async transferOrder(
    organizationId: string,
    orderId: string,
    toWaiterId: string,
    actor: TransferActor,
    options: { wholeTable?: boolean } = {},
  ): Promise<TransferResult> {
    const result = await this.dataSource.transaction(async (manager) => {
      const [order] = rowsOf<OpenOrderRow & { open: boolean }>(
        await manager.query(
          `SELECT o.id, o.event_id, o.waiter_id, o.table_id, o.table_number,
                  (${OPEN_ORDER_SQL}) AS open
             FROM orders o WHERE o.id = $1 AND o.organization_id = $2 FOR UPDATE`,
          [orderId, organizationId],
        ),
      );
      if (!order) {
        throw new NotFoundException({
          code: ErrorCodes.NOT_FOUND,
          reason: ErrorReasons.ORDER_NOT_FOUND,
          message: 'Bestellung nicht gefunden',
        });
      }
      if (!order.open) {
        throw invalid('Nur offene Bestellungen lassen sich übergeben.');
      }
      this.assertMay(actor, order.waiter_id);
      const orders: OpenOrderRow[] = [order];
      if (options.wholeTable && (order.table_id || order.table_number)) {
        const others = rowsOf<OpenOrderRow>(
          await manager.query(
            `SELECT o.id, o.event_id, o.waiter_id, o.table_id, o.table_number
               FROM orders o
              WHERE o.organization_id = $1 AND o.id <> $2
                AND o.event_id IS NOT DISTINCT FROM $3
                AND o.waiter_id IS NOT DISTINCT FROM $4
                AND (($5::uuid IS NOT NULL AND o.table_id = $5)
                     OR ($5::uuid IS NULL AND upper(trim(o.table_number)) = upper(trim($6))))
                AND o.is_test = (SELECT is_test FROM orders WHERE id = $2)
                AND ${OPEN_ORDER_SQL}
              FOR UPDATE`,
            [
              organizationId,
              order.id,
              order.event_id,
              order.waiter_id,
              order.table_id,
              order.table_number ?? '',
            ],
          ),
        );
        orders.push(...others);
      }
      return this.apply(manager, organizationId, orders, toWaiterId, actor);
    });
    this.notify(organizationId, result, null);
    return result;
  }

  /**
   * Verwaltung: alle offenen Bestellungen einer Bedienung (optional einer
   * Veranstaltung) an eine andere uebergeben — z. B. vor der Abrechnung.
   */
  async transferAllOpen(
    organizationId: string,
    fromWaiterId: string,
    toWaiterId: string,
    actor: TransferActor,
    eventId?: string | null,
  ): Promise<TransferResult> {
    if (fromWaiterId === toWaiterId) {
      throw invalid('Wähle eine andere Bedienung.');
    }
    const result = await this.dataSource.transaction(async (manager) => {
      const orders = rowsOf<OpenOrderRow>(
        await manager.query(
          `SELECT o.id, o.event_id, o.waiter_id, o.table_id, o.table_number
             FROM orders o
            WHERE o.organization_id = $1 AND o.waiter_id = $2
              AND ($3::uuid IS NULL OR o.event_id = $3)
              AND ${OPEN_ORDER_SQL}
            FOR UPDATE`,
          [organizationId, fromWaiterId, eventId ?? null],
        ),
      );
      if (!orders.length) {
        throw invalid('Diese Bedienung hat keine offenen Tische.');
      }
      return this.apply(manager, organizationId, orders, toWaiterId, actor);
    });
    await this.audit(organizationId, result, actor);
    this.notify(organizationId, result, eventId ?? null);
    return result;
  }

  private assertMay(actor: TransferActor, ownerId: string | null): void {
    if (actor.admin) return;
    const operator = actor.operator;
    if (!operator) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.WAITER_SESSION_REQUIRED,
        message: 'Bitte melde dich an der Kasse mit deiner PIN an.',
      });
    }
    const lead = operator.role === 'lead' || operator.role === 'admin';
    const own =
      !ownerId || (!!operator.waiterId && operator.waiterId === ownerId);
    if (!lead && !own) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.WAITER_NOT_PERMITTED,
        message: 'Fremde Tische übergibt eine Schichtleitung oder ein Admin.',
        params: { permission: 'transfer' },
      });
    }
  }

  private async apply(
    manager: EntityManager,
    organizationId: string,
    orders: OpenOrderRow[],
    toWaiterId: string,
    actor: TransferActor,
  ): Promise<TransferResult> {
    const [target] = rowsOf<{
      id: string;
      name: string;
      short_name: string | null;
      color: string | null;
      event_id: string | null;
      is_active: boolean;
      anonymized_at: Date | null;
    }>(
      await manager.query(
        `SELECT id, name, short_name, color, event_id, is_active, anonymized_at
           FROM waiters WHERE id = $1 AND organization_id = $2`,
        [toWaiterId, organizationId],
      ),
    );
    if (!target || !target.is_active || target.anonymized_at) {
      throw invalid('Diese Bedienung ist nicht verfügbar.');
    }
    const moving = orders.filter((o) => o.waiter_id !== target.id);
    if (!moving.length) {
      throw invalid('Der Tisch gehört schon dieser Bedienung.');
    }
    for (const order of moving) {
      if (target.event_id && order.event_id !== target.event_id) {
        throw invalid('Diese Bedienung gehört zu einer anderen Veranstaltung.');
      }
    }
    const ids = moving.map((o) => o.id);
    await manager.query(
      `UPDATE orders SET waiter_id = $1, updated_at = now() WHERE id = ANY($2::uuid[])`,
      [target.id, ids],
    );
    const operator = actor.operator ?? null;
    await manager.getRepository(OrderEvent).save(
      moving.map((o) =>
        manager.getRepository(OrderEvent).create({
          organizationId,
          orderId: o.id,
          type: 'transferred',
          deviceId: actor.deviceId ?? null,
          userId: operator ? operator.userId : (actor.userId ?? null),
          waiterId: operator?.waiterId ?? null,
          actorName: operator?.name ?? null,
          data: { fromWaiterId: o.waiter_id, toWaiterId: target.id },
        }),
      ),
    );
    this.logger.log(
      `${ids.length} order(s) transferred to waiter ${target.id} in organization ${organizationId}`,
    );
    return {
      orderIds: ids,
      toWaiter: {
        id: target.id,
        name: target.name,
        shortName: target.short_name,
        color: target.color,
      },
      fromWaiterIds: [...new Set(moving.map((o) => o.waiter_id))],
      eventId: moving[0].event_id,
      tableNumber: moving[0].table_number,
    };
  }

  private notify(
    organizationId: string,
    result: TransferResult,
    eventId: string | null,
  ): void {
    try {
      this.gateway?.notifyOrderTransferred(organizationId, {
        orderIds: result.orderIds,
        eventId: result.eventId ?? eventId,
        tableNumber: result.tableNumber,
        fromWaiterId: result.fromWaiterIds[0] ?? null,
        toWaiterId: result.toWaiter.id,
        toName:
          result.toWaiter.shortName ||
          result.toWaiter.name.trim().split(/\s+/)[0].slice(0, 12),
      });
      this.gateway?.notifyTablesUpdated(organizationId);
    } catch (error) {
      this.logger.warn(
        `orderTransferred not sent: ${(error as Error).message}`,
      );
    }
  }

  private async audit(
    organizationId: string,
    result: TransferResult,
    actor: TransferActor,
  ): Promise<void> {
    try {
      const repo = this.dataSource.getRepository(AdminAuditLog);
      await repo.save(
        repo.create({
          adminUserId: actor.userId ?? null,
          organizationId,
          action: AdminAction.WAITER_TABLES_TRANSFERRED,
          resourceType: 'waiter',
          resourceId: result.toWaiter.id,
          details: {
            orderIds: result.orderIds,
            fromWaiterIds: result.fromWaiterIds,
          },
          ipAddress: (actor.ipAddress || SYSTEM_AUDIT_IP).slice(0, 45),
          userAgent: actor.userAgent?.slice(0, 500) ?? null,
        }),
      );
    } catch (error) {
      this.logger.error(
        `Audit waiter_tables_transferred for org ${organizationId} not written: ${(error as Error).message}`,
      );
    }
  }
}
