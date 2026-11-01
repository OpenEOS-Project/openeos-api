import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import {
  OrderSource,
  OrderStatus,
  PaymentStatus,
  type Order,
  type OrderItem,
} from '../../../database/entities';
import { TokenScope } from '../../api-tokens/api-scopes';
import type { QueryOrdersDto } from '../../orders/dto';
import { OrdersService } from '../../orders/orders.service';
import type { QueryReportsDto } from '../../reports/dto';
import { ReportsService } from '../../reports/reports.service';
import { defineTool, type AgentTool } from '../agent-tool.types';
import {
  dateInput,
  iso,
  listInput,
  money,
  uuid,
  windowed,
} from '../tool-helpers';

const ORDER_ONLY_NOTE =
  'Order-only mode (Nur Bestellen): OpenEOS takes orders but collects no money. There is no revenue; orderValue is the sum of the order prices, not collected by OpenEOS (Bestellwert, nicht kassiert). Payments only contain online prepayments from the shop.';

const SECTIONS = [
  'summary',
  'net',
  'products',
  'categories',
  'hourly',
  'payments',
  'channels',
] as const;

/* Bestellungen ohne alles, was auf einen Gast zeigt: kein Name, keine
   Telefonnummer, keine Notizen, kein Kassierer. */
function compactItem(item: OrderItem) {
  return {
    productName: item.productName,
    categoryName: item.categoryName ?? null,
    quantity: item.quantity,
    unitPrice: money(item.unitPrice),
    totalPrice: money(item.totalPrice),
    taxRate: Number(item.taxRate ?? 0),
    deposit: money(item.depositAmount),
    status: item.status,
    options: (item.options?.selected ?? []).map((o) => o.option),
  };
}

function compactOrder(
  order: Order & { displayStatus?: string; paymentMethods?: string[] },
  withItems: boolean,
) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    dailyNumber: order.dailyNumber,
    createdAt: iso(order.createdAt),
    completedAt: iso(order.completedAt),
    status: order.status,
    paymentStatus: order.paymentStatus,
    displayStatus: order.displayStatus ?? null,
    source: order.source,
    fulfillmentType: order.fulfillmentType,
    isTest: order.isTest,
    eventId: order.eventId ?? null,
    tableNumber: order.tableNumber ?? null,
    subtotal: money(order.subtotal),
    pfandTotal: money(order.pfandTotal),
    tipAmount: money(order.tipAmount),
    discountAmount: money(order.discountAmount),
    refundedAmount: money(order.refundedAmount),
    total: money(order.total),
    paymentMethods: order.paymentMethods ?? [],
    itemCount: order.items?.length ?? undefined,
    ...(withItems && order.items
      ? { items: order.items.map(compactItem) }
      : {}),
  };
}

@Injectable()
export class ReportTools {
  constructor(
    private readonly reports: ReportsService,
    private readonly orders: OrdersService,
  ) {}

  tools(): AgentTool[] {
    return [this.salesReport(), this.listOrders(), this.getOrder()];
  }

  private salesReport() {
    return defineTool({
      name: 'get_sales_report',
      description:
        'Sales figures (EUR) for an event and/or date range: summary (revenue, orders, average receipt, Pfand, cancellations), net (items revenue, refunds, tips, net), by product, by category, by hour (only hours with orders), by payment method, by channel. Pick sections to keep the answer small. Needs the reports permission. ' +
        'If the answer has operatingMode "order_only" (Nur Bestellen), OpenEOS only takes orders and does not collect money: there is no revenue — use the counts (orders, items, quantities) and treat orderValue as the sum of the order prices, not collected by OpenEOS (German: „Bestellwert (nicht kassiert)“). Payments then only contain online prepayments from the shop.',
      inputSchema: z
        .object({
          eventId: uuid.optional(),
          startDate: dateInput.optional(),
          endDate: dateInput.optional(),
          sections: z
            .array(z.enum(SECTIONS))
            .min(1)
            .default(['summary', 'products', 'categories', 'payments']),
        })
        .strict(),
      scope: TokenScope.READ,
      mutating: false,
      handler: async (ctx, input) => {
        const query = {
          eventId: input.eventId,
          startDate: input.startDate,
          endDate: input.endDate,
        } as QueryReportsDto;
        const wants = new Set(input.sections);
        const org = ctx.organizationId;
        /* „Nur Bestellen“: OpenEOS kassiert nicht. Die Berichte rechnen
           gleich, aber ein Betrag heisst hier `orderValue` (Bestellwert,
           nicht kassiert) statt `revenue` — sonst liest ein Modell die
           Summe als Umsatz. */
        const orderOnly =
          (await this.reports.getOperatingMode(org)) === 'order_only';
        const out: Record<string, unknown> = orderOnly
          ? {
              filter: query,
              operatingMode: 'order_only',
              note: ORDER_ONLY_NOTE,
            }
          : { filter: query };
        if (wants.has('summary')) {
          const s = await this.reports.getSalesReport(org, query, ctx.user);
          out.summary = orderOnly
            ? {
                orders: s.totalOrders,
                itemsSold: s.totalItemsSold,
                cancelledOrders: s.cancelledOrders,
                cancellationRatePercent: money(s.cancellationRate),
                orderValue: money(s.totalRevenue),
                averageOrderValue: money(s.averageOrderValue),
              }
            : {
                revenue: money(s.totalRevenue),
                orders: s.totalOrders,
                averageReceipt: money(s.averageOrderValue),
                itemsSold: s.totalItemsSold,
                pfandCollected: money(s.pfandCollected),
                pfandReturned: money(s.pfandReturned),
                pfandBalance: money(s.pfandBalance),
                cancelledOrders: s.cancelledOrders,
                cancellationRatePercent: money(s.cancellationRate),
              };
        }
        if (wants.has('net')) {
          const n = await this.reports.getNetSalesSummary(org, query, ctx.user);
          out.net = orderOnly
            ? {
                itemsOrderValue: money(n.itemsRevenue),
                unassignedRefunds: money(n.unassignedRefunds),
                orderValue: money(n.netRevenue),
              }
            : {
                itemsRevenue: money(n.itemsRevenue),
                unassignedRefunds: money(n.unassignedRefunds),
                tips: money(n.tips),
                netRevenue: money(n.netRevenue),
              };
        }
        /** Betrag einer Zeile: Umsatz bzw. Bestellwert (nicht kassiert). */
        const amount = (value: number) =>
          orderOnly ? { orderValue: money(value) } : { revenue: money(value) };
        if (wants.has('products')) {
          const rows = await this.reports.getProductsReport(
            org,
            query,
            ctx.user,
          );
          out.products = rows.map((r) => ({
            productId: r.productId,
            name: r.productName,
            category: r.categoryName ?? null,
            quantity: r.quantitySold,
            ...amount(r.revenue),
            averagePrice: money(r.averagePrice),
          }));
        }
        if (wants.has('categories')) {
          const rows = await this.reports.getCategoriesReport(
            org,
            query,
            ctx.user,
          );
          out.categories = rows.map((r) => ({
            categoryId: r.categoryId,
            name: r.name,
            quantity: r.quantity,
            ...amount(r.revenue),
          }));
        }
        if (wants.has('hourly')) {
          const rows = await this.reports.getHourlyReport(org, query, ctx.user);
          out.hourly = rows
            .filter((r) => r.orders > 0)
            .map((r) => ({
              date: r.date,
              hour: r.hour,
              orders: r.orders,
              ...amount(r.revenue),
            }));
        }
        if (wants.has('payments')) {
          const rows = await this.reports.getPaymentsReport(
            org,
            query,
            ctx.user,
          );
          out.payments = rows.map((r) => ({
            method: r.method,
            count: r.count,
            total: money(r.total),
            percent: money(r.percentage),
          }));
        }
        if (wants.has('channels')) {
          const rows = await this.reports.getChannelsReport(
            org,
            query,
            ctx.user,
          );
          out.channels = rows.map((r) => ({
            channel: r.channel,
            orders: r.orders,
            ...amount(r.revenue),
            ...(orderOnly
              ? { averageOrderValue: money(r.avgReceipt) }
              : { averageReceipt: money(r.avgReceipt) }),
          }));
        }
        return out;
      },
    });
  }

  private listOrders() {
    return defineTool({
      name: 'list_orders',
      description:
        'Orders (newest first), anonymised: number, time, status, totals in EUR, payment methods, table; includeItems adds line items. No guest or cashier data. offset should be a multiple of limit.',
      inputSchema: z
        .object({
          eventId: uuid.optional(),
          status: z.nativeEnum(OrderStatus).optional(),
          paymentStatus: z.nativeEnum(PaymentStatus).optional(),
          source: z.nativeEnum(OrderSource).optional(),
          paymentMethod: z
            .enum(['cash', 'card', 'sumup', 'discount'])
            .optional(),
          dateFrom: dateInput.optional(),
          dateTo: dateInput.optional(),
          includeItems: z.boolean().default(false),
          ...listInput,
        })
        .strict(),
      scope: TokenScope.READ,
      mutating: false,
      handler: async (ctx, input) => {
        const { limit, offset, includeItems, ...filters } = input;
        const page = await windowed(
          (p) =>
            this.orders.findAll(ctx.organizationId, ctx.user, {
              ...p,
              ...filters,
              includeItems,
            } as QueryOrdersDto),
          offset,
          limit,
          100,
        );
        return {
          ...page,
          items: page.items.map((o) => compactOrder(o, includeItems)),
        };
      },
    });
  }

  private getOrder() {
    return defineTool({
      name: 'get_order',
      description:
        'One order with line items, anonymised (no guest or cashier data).',
      inputSchema: z.object({ orderId: uuid }).strict(),
      scope: TokenScope.READ,
      mutating: false,
      handler: async (ctx, input) =>
        compactOrder(
          await this.orders.findOne(
            ctx.organizationId,
            input.orderId,
            ctx.user,
          ),
          true,
        ),
    });
  }
}
