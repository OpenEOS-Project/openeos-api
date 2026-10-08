import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  In,
  Repository,
  type ObjectLiteral,
  type SelectQueryBuilder,
} from 'typeorm';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  Order,
  OrderItem,
  OrderEvent,
  Payment,
  Refund,
} from '../../database/entities';
import { OrderItemStatus } from '../../database/entities/order-item.entity';
import {
  PaymentMethod,
  PaymentTransactionStatus,
} from '../../database/entities/payment.entity';
import {
  ORDER_DISPLAY_STATUSES,
  cents,
  displayStatusOf,
  displayStatusSql,
  discountFactor,
  round2,
  unitGross,
  type OrderDisplayStatus,
} from './refund-calc';
import {
  HISTORY_PAYMENT_FILTERS,
  type HistoryPaymentFilter,
} from './dto/refund.dto';

export interface OrderHistoryFilters {
  eventId?: string | null;
  /** ISO-Zeitpunkt, inklusive. */
  from?: Date | null;
  to?: Date | null;
  q?: string | null;
  displayStatuses?: OrderDisplayStatus[];
  paymentMethods?: HistoryPaymentFilter[];
  /** Nur Bestellungen dieses Geraets. */
  deviceId?: string | null;
  /** Alter Filter der Kasse (Bestellstatus). */
  status?: string | null;
}

export interface OrderHistoryRow {
  id: string;
  orderNumber: string;
  dailyNumber: number;
  createdAt: Date;
  tableNumber: string | null;
  fulfillmentType: string;
  source: string;
  customerName: string | null;
  notes: string | null;
  status: string;
  paymentStatus: string;
  displayStatus: OrderDisplayStatus;
  subtotal: number;
  total: number;
  paidAmount: number;
  refundedAmount: number;
  tipAmount: number;
  discountAmount: number;
  pfandTotal: number;
  isTest: boolean;
  eventId: string | null;
  createdByDeviceId: string | null;
  deviceName: string | null;
  paymentMethods: string[];
  items: {
    id: string;
    productName: string;
    quantity: number;
    status: string;
    totalPrice: number;
  }[];
}

export interface OrderHistoryPage {
  data: OrderHistoryRow[];
  meta: {
    limit: number;
    total: number;
    nextCursor: string | null;
    /** Treffer je Status bei sonst gleichen Filtern (ohne Statusfilter). */
    counts: Record<OrderDisplayStatus | 'all', number>;
    page?: number;
    totalPages?: number;
  };
}

/**
 * Suche, Zahlart und Status (wie in der Kasse) — gemeinsam fuer den
 * Verlauf der Kasse und die Bestellliste der Verwaltung.
 */
export function applyHistoryFilters<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  alias: string,
  filters: Pick<
    OrderHistoryFilters,
    'q' | 'paymentMethods' | 'displayStatuses'
  >,
): void {
  if (filters.q) {
    const raw = filters.q.replace(/^#/, '').trim();
    if (raw) {
      const like = `%${raw.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const numeric = /^\d+$/.test(raw) ? Number(raw) : null;
      qb.andWhere(
        `(${alias}.order_number ILIKE :like
          OR ${alias}.table_number ILIKE :like
          OR ${alias}.customer_name ILIKE :like
          ${numeric !== null ? `OR ${alias}.daily_number = :numeric` : ''}
          OR EXISTS (SELECT 1 FROM order_items qi
                     WHERE qi.order_id = ${alias}.id AND qi.product_name ILIKE :like))`,
        { like, numeric },
      );
    }
  }
  if (filters.paymentMethods?.length) {
    const methods: string[] = [];
    for (const m of filters.paymentMethods) {
      if (m === 'cash') methods.push(PaymentMethod.CASH);
      if (m === 'card') methods.push(PaymentMethod.CARD);
      if (m === 'sumup') {
        methods.push(PaymentMethod.SUMUP_TERMINAL, PaymentMethod.SUMUP_ONLINE);
      }
    }
    const parts: string[] = [];
    if (methods.length) {
      parts.push(`EXISTS (SELECT 1 FROM payments fp
        WHERE fp.order_id = ${alias}.id AND fp.payment_method::text IN (:...methods)
          AND fp.status IN ('captured', 'refunded'))`);
    }
    if (filters.paymentMethods.includes('discount')) {
      parts.push(`${alias}.discount_amount > 0`);
    }
    if (parts.length) {
      qb.andWhere(`(${parts.join(' OR ')})`, { methods });
    }
  }
  if (filters.displayStatuses?.length) {
    qb.andWhere(`${displayStatusSql(alias)} IN (:...displayStatuses)`, {
      displayStatuses: filters.displayStatuses,
    });
  }
}

const MAX_LIMIT = 100;

/** Cursor = Anlagezeit + ID der letzten Zeile (stabile Reihenfolge). */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(
  cursor: string | null | undefined,
): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString().split('|');
    const createdAt = new Date(iso);
    if (!id || Number.isNaN(createdAt.getTime())) return null;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/** Liest kommagetrennte Listen aus der Query und laesst nur bekannte Werte durch. */
export function parseList<T extends string>(
  raw: string | string[] | undefined,
  allowed: readonly T[],
): T[] {
  if (!raw) return [];
  const values = (Array.isArray(raw) ? raw : raw.split(','))
    .map((v) => v.trim())
    .filter(Boolean);
  return values.filter((v): v is T =>
    (allowed as readonly string[]).includes(v),
  );
}

export function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseHistoryFilters(query: {
  eventId?: string;
  from?: string;
  to?: string;
  q?: string;
  displayStatus?: string | string[];
  paymentMethod?: string | string[];
  status?: string;
}): OrderHistoryFilters {
  return {
    eventId: query.eventId || null,
    from: parseDate(query.from),
    to: parseDate(query.to),
    q: query.q?.trim().slice(0, 100) || null,
    displayStatuses: parseList(query.displayStatus, ORDER_DISPLAY_STATUSES),
    paymentMethods: parseList(query.paymentMethod, HISTORY_PAYMENT_FILTERS),
    status: query.status || null,
  };
}

/**
 * Bestellverlauf fuer Kasse und Verwaltung: Filter und Seiten serverseitig
 * (performant bei 1000+ Bestellungen), ein klarer Status je Bestellung,
 * Kurzinhalt, Zahlarten. Und die Detailansicht mit Positionen, Zahlungen,
 * Erstattungen und Verlauf.
 */
@Injectable()
export class OrderHistoryService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(OrderItem)
    private readonly orderItemRepository: Repository<OrderItem>,
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    @InjectRepository(Refund)
    private readonly refundRepository: Repository<Refund>,
    @InjectRepository(OrderEvent)
    private readonly orderEventRepository: Repository<OrderEvent>,
  ) {}

  private applyFilters(
    qb: SelectQueryBuilder<Order>,
    organizationId: string,
    filters: OrderHistoryFilters,
    withStatus: boolean,
  ) {
    qb.where('o.organization_id = :organizationId', { organizationId });
    if (filters.eventId) {
      qb.andWhere('o.event_id = :eventId', { eventId: filters.eventId });
    }
    if (filters.deviceId) {
      qb.andWhere('o.created_by_device_id = :deviceId', {
        deviceId: filters.deviceId,
      });
    }
    if (filters.from) {
      qb.andWhere('o.created_at >= :from', { from: filters.from });
    }
    if (filters.to) {
      qb.andWhere('o.created_at <= :to', { to: filters.to });
    }
    applyHistoryFilters(qb, 'o', {
      q: filters.q,
      paymentMethods: filters.paymentMethods,
      displayStatuses: withStatus ? filters.displayStatuses : [],
    });
    if (filters.status) {
      qb.andWhere('o.status = :legacyStatus', { legacyStatus: filters.status });
    }
    return qb;
  }

  async list(
    organizationId: string,
    filters: OrderHistoryFilters,
    options: { limit?: number; cursor?: string | null; page?: number | null },
  ): Promise<OrderHistoryPage> {
    const limit = Math.min(MAX_LIMIT, Math.max(1, options.limit || 50));
    const cursor = decodeCursor(options.cursor);

    const qb = this.applyFilters(
      this.orderRepository.createQueryBuilder('o'),
      organizationId,
      filters,
      true,
    )
      .leftJoin('o.createdByDevice', 'd')
      .select([
        'o.id AS id',
        'o.order_number AS "orderNumber"',
        'o.daily_number AS "dailyNumber"',
        'o.created_at AS "createdAt"',
        'o.table_number AS "tableNumber"',
        'o.fulfillment_type AS "fulfillmentType"',
        'o.source AS source',
        'o.customer_name AS "customerName"',
        'o.notes AS notes',
        'o.status AS status',
        'o.payment_status AS "paymentStatus"',
        `${displayStatusSql('o')} AS "displayStatus"`,
        'o.subtotal AS subtotal',
        'o.total AS total',
        'o.paid_amount AS "paidAmount"',
        'o.refunded_amount AS "refundedAmount"',
        'o.tip_amount AS "tipAmount"',
        'o.discount_amount AS "discountAmount"',
        'o.pfand_total AS "pfandTotal"',
        'o.is_test AS "isTest"',
        'o.event_id AS "eventId"',
        'o.created_by_device_id AS "createdByDeviceId"',
        'd.name AS "deviceName"',
        `ARRAY(SELECT DISTINCT pm.payment_method::text FROM payments pm
           WHERE pm.order_id = o.id AND pm.status IN ('captured', 'refunded'))
           AS "paymentMethods"`,
      ])
      .orderBy('o.created_at', 'DESC')
      .addOrderBy('o.id', 'DESC')
      .limit(limit + 1);

    const page =
      !cursor && options.page && options.page > 1 ? options.page : null;
    if (cursor) {
      qb.andWhere('(o.created_at, o.id) < (:cursorAt, :cursorId)', {
        cursorAt: cursor.createdAt,
        cursorId: cursor.id,
      });
    } else if (page) {
      qb.offset((page - 1) * limit);
    }

    type RawRow = Omit<
      OrderHistoryRow,
      | 'items'
      | 'subtotal'
      | 'total'
      | 'paidAmount'
      | 'refundedAmount'
      | 'tipAmount'
      | 'discountAmount'
      | 'pfandTotal'
    > &
      Record<
        | 'subtotal'
        | 'total'
        | 'paidAmount'
        | 'refundedAmount'
        | 'tipAmount'
        | 'discountAmount'
        | 'pfandTotal',
        string
      >;

    const [rawRows, counts] = await Promise.all([
      qb.getRawMany<RawRow>(),
      this.counts(organizationId, filters),
    ]);

    const hasMore = rawRows.length > limit;
    const rows = rawRows.slice(0, limit);
    const ids = rows.map((r) => r.id);
    const items = ids.length
      ? await this.orderItemRepository.find({
          where: { orderId: In(ids) },
          select: [
            'id',
            'orderId',
            'productName',
            'quantity',
            'status',
            'totalPrice',
            'sortOrder',
            'createdAt',
          ],
          order: { sortOrder: 'ASC', createdAt: 'ASC' },
        })
      : [];

    const data: OrderHistoryRow[] = rows.map((r) => ({
      ...r,
      createdAt: new Date(r.createdAt),
      subtotal: Number(r.subtotal),
      total: Number(r.total),
      paidAmount: Number(r.paidAmount),
      refundedAmount: Number(r.refundedAmount),
      tipAmount: Number(r.tipAmount),
      discountAmount: Number(r.discountAmount),
      pfandTotal: Number(r.pfandTotal),
      paymentMethods: r.paymentMethods ?? [],
      items: items
        .filter((i) => i.orderId === r.id)
        .map((i) => ({
          id: i.id,
          productName: i.productName,
          quantity: i.quantity,
          status: i.status,
          totalPrice: Number(i.totalPrice),
        })),
    }));

    const last = rows[rows.length - 1];
    const selected = filters.displayStatuses?.length
      ? filters.displayStatuses.reduce((sum, s) => sum + (counts[s] ?? 0), 0)
      : counts.all;
    return {
      data,
      meta: {
        limit,
        total: selected,
        nextCursor:
          hasMore && last
            ? encodeCursor(new Date(last.createdAt), last.id)
            : null,
        counts,
        ...(options.page
          ? {
              page: options.page,
              totalPages: Math.max(1, Math.ceil(selected / limit)),
            }
          : {}),
      },
    };
  }

  private async counts(
    organizationId: string,
    filters: OrderHistoryFilters,
  ): Promise<Record<OrderDisplayStatus | 'all', number>> {
    const raw = await this.applyFilters(
      this.orderRepository.createQueryBuilder('o'),
      organizationId,
      filters,
      false,
    )
      .select(`${displayStatusSql('o')}`, 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('1')
      .getRawMany<{ status: OrderDisplayStatus; count: string }>();
    const counts = Object.fromEntries(
      [...ORDER_DISPLAY_STATUSES, 'all'].map((s) => [s, 0]),
    ) as Record<OrderDisplayStatus | 'all', number>;
    for (const row of raw) {
      counts[row.status] = Number(row.count);
      counts.all += Number(row.count);
    }
    return counts;
  }

  /** Detail einer Bestellung inkl. Zahlungen, Erstattungen und Verlauf. */
  async detail(organizationId: string, orderId: string) {
    const order = await this.orderRepository.findOne({
      where: { id: orderId, organizationId },
      relations: ['items', 'createdByDevice', 'createdByUser'],
    });
    if (!order) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.ORDER_NOT_FOUND,
        message: 'Bestellung nicht gefunden',
      });
    }
    const [payments, refunds, events] = await Promise.all([
      this.paymentRepository.find({
        where: { orderId },
        relations: ['processedByDevice', 'processedByUser'],
        order: { createdAt: 'ASC' },
      }),
      this.refundRepository.find({
        where: { orderId },
        relations: ['items', 'device'],
        order: { createdAt: 'ASC' },
      }),
      this.orderEventRepository.find({
        where: { orderId },
        order: { createdAt: 'ASC' },
      }),
    ]);

    const items = [...order.items].sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const factor = discountFactor(items, order.discountAmount);
    const refundedByPayment = new Map<string, number>();
    for (const r of refunds) {
      if (!r.paymentId) continue;
      refundedByPayment.set(
        r.paymentId,
        (refundedByPayment.get(r.paymentId) ?? 0) - cents(r.amount),
      );
    }

    const paymentRows = payments.map((p) => {
      const refunded = (refundedByPayment.get(p.id) ?? 0) / 100;
      const amountReceived =
        typeof p.metadata?.amountReceived === 'number'
          ? p.metadata.amountReceived
          : null;
      const counted =
        p.status === PaymentTransactionStatus.CAPTURED ||
        p.status === PaymentTransactionStatus.REFUNDED;
      return {
        id: p.id,
        amount: Number(p.amount),
        paymentMethod: p.paymentMethod,
        paymentProvider: p.paymentProvider,
        status: p.status,
        providerTransactionId: p.providerTransactionId,
        amountReceived,
        change:
          amountReceived !== null
            ? Math.max(0, round2(amountReceived - Number(p.amount)))
            : null,
        tipAmount:
          typeof p.metadata?.tipAmount === 'number'
            ? p.metadata.tipAmount
            : null,
        batchOrderCount:
          typeof p.metadata?.batchOrderCount === 'number'
            ? p.metadata.batchOrderCount
            : null,
        cardBrand: p.metadata?.cardBrand ?? null,
        cardLastFour: p.metadata?.cardLastFour ?? null,
        refundedAmount: round2(refunded),
        refundable: counted
          ? Math.max(0, round2(Number(p.amount) - refunded))
          : 0,
        createdAt: p.createdAt,
        deviceId: p.processedByDeviceId,
        deviceName: p.processedByDevice?.name ?? null,
        userName: p.processedByUser
          ? `${p.processedByUser.firstName ?? ''} ${p.processedByUser.lastName ?? ''}`.trim()
          : null,
      };
    });

    const refundable = round2(
      Math.max(0, Number(order.paidAmount) - Number(order.refundedAmount || 0)),
    );

    return {
      id: order.id,
      orderNumber: order.orderNumber,
      dailyNumber: order.dailyNumber,
      createdAt: order.createdAt,
      tableNumber: order.tableNumber,
      fulfillmentType: order.fulfillmentType,
      source: order.source,
      customerName: order.customerName,
      notes: order.notes,
      status: order.status,
      paymentStatus: order.paymentStatus,
      displayStatus: displayStatusOf(order),
      subtotal: Number(order.subtotal),
      taxTotal: Number(order.taxTotal),
      total: Number(order.total),
      paidAmount: Number(order.paidAmount),
      refundedAmount: Number(order.refundedAmount || 0),
      refundable,
      remaining: round2(
        Math.max(0, Number(order.total) - Number(order.paidAmount)),
      ),
      tipAmount: Number(order.tipAmount),
      discountAmount: Number(order.discountAmount),
      discountReason: order.discountReason,
      pfandTotal: Number(order.pfandTotal),
      isTest: order.isTest,
      eventId: order.eventId,
      readyAt: order.readyAt,
      completedAt: order.completedAt,
      cancelledAt: order.cancelledAt,
      cancellationReason: order.cancellationReason,
      createdByDeviceId: order.createdByDeviceId,
      deviceName: order.createdByDevice?.name ?? null,
      createdByUserName: order.createdByUser
        ? `${order.createdByUser.firstName ?? ''} ${order.createdByUser.lastName ?? ''}`.trim()
        : null,
      items: items.map((i) => {
        const active = i.status !== OrderItemStatus.CANCELLED;
        const refundableQuantity = active
          ? Math.max(0, i.quantity - (i.refundedQuantity || 0))
          : 0;
        return {
          id: i.id,
          productId: i.productId,
          productName: i.productName,
          categoryName: i.categoryName,
          quantity: i.quantity,
          unitPrice: Number(i.unitPrice),
          optionsPrice: Number(i.optionsPrice || 0),
          totalPrice: Number(i.totalPrice),
          taxRate: Number(i.taxRate),
          depositAmount: Number(i.depositAmount || 0),
          isRefill: i.isRefill,
          options: i.options?.selected ?? [],
          notes: i.notes,
          kitchenNotes: i.kitchenNotes,
          status: i.status,
          productionStationId: i.productionStationId,
          paidQuantity: i.paidQuantity,
          refundedQuantity: i.refundedQuantity || 0,
          refundableQuantity,
          /** Erstattung je Stueck ohne Storno (Rabatt anteilig, ohne Pfand). */
          unitRefund: round2(unitGross(i) * factor),
          preparedAt: i.preparedAt,
          readyAt: i.readyAt,
          deliveredAt: i.deliveredAt,
          createdAt: i.createdAt,
          updatedAt: i.updatedAt,
        };
      }),
      payments: paymentRows,
      refunds: refunds.map((r) => ({
        id: r.id,
        refundNumber: r.refundNumber,
        kind: r.kind,
        amount: Number(r.amount),
        taxTotal: Number(r.taxTotal),
        pfandAmount: Number(r.pfandAmount),
        tipAmount: Number(r.tipAmount),
        taxLines: r.taxLines ?? [],
        paymentId: r.paymentId,
        paymentMethod: r.paymentMethod,
        status: r.status,
        provider: r.provider,
        providerReference: r.providerReference,
        reasonCode: r.reasonCode,
        reasonText: r.reasonText,
        deviceId: r.deviceId,
        deviceName: r.device?.name ?? null,
        userId: r.userId,
        actorName: r.actorName,
        isTest: r.isTest,
        createdAt: r.createdAt,
        items: (r.items ?? []).map((ri) => ({
          id: ri.id,
          orderItemId: ri.orderItemId,
          productName: ri.productName,
          quantity: ri.quantity,
          unitPrice: Number(ri.unitPrice),
          taxRate: Number(ri.taxRate),
          amount: Number(ri.amount),
          depositAmount: Number(ri.depositAmount),
          cancelled: ri.cancelled,
        })),
      })),
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        createdAt: e.createdAt,
        deviceId: e.deviceId,
        userId: e.userId,
        actorName: e.actorName,
        data: e.data,
      })),
    };
  }
}

export type OrderHistoryDetail = Awaited<
  ReturnType<OrderHistoryService['detail']>
>;
