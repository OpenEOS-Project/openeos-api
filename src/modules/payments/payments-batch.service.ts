import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, In } from 'typeorm';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  Order,
  OrderStatus,
  PaymentStatus,
} from '../../database/entities/order.entity';
import {
  OrderItem,
  OrderItemStatus,
} from '../../database/entities/order-item.entity';
import { Organization } from '../../database/entities/organization.entity';
import {
  Payment,
  PaymentMethod,
  PaymentProvider,
  PaymentTransactionStatus,
} from '../../database/entities/payment.entity';
import { GatewayService } from '../gateway/gateway.service';
import { assertIntegrationEnabled } from '../integrations/integration-catalog';
import { OrderPrintService } from '../print-jobs/order-print.service';
import {
  cashReceivedMetadata,
  orderTaxTotal,
} from '../print-jobs/receipt-tax.util';
import { BatchPaymentDto } from './dto/batch-payment.dto';

/**
 * Sammelzahlung der Kasse (Spezifikation §3.4, §5.2.3): mehrere offene
 * Bestellungen in **einer** Transaktion kassieren. Liegt bewusst neben
 * payments.service.ts (dort aendert api #12 die TSE-Anbindung).
 *
 * - Alle Bestellungen werden mit `SELECT … FOR UPDATE` gesperrt (feste
 *   Reihenfolge nach ID, keine Deadlocks). Ist eine davon schon bezahlt
 *   oder storniert, wird nichts gebucht (409 / 400).
 * - Je Bestellung eine Zahlung ueber ihren Restbetrag.
 * - Rabatt wird von der letzten Bestellung rueckwaerts verteilt, je
 *   Bestellung gedeckelt auf ihren offenen Betrag ohne Pfand; was darueber
 *   hinausgeht, verfaellt (wie beim Anlegen einer Bestellung).
 * - Trinkgeld landet auf der letzten Bestellung.
 * - Erhaltenes Bargeld traegt nur die letzte Zahlung, abzueglich dessen,
 *   was die anderen abdecken (wie `amountReceivedFor` in der Kasse) — so
 *   zeigt ihr Bon genau das Rueckgeld, das der Gast bekommt.
 */

const round2 = (value: number): number => Math.round(value * 100) / 100;
const cents = (value: number): number => Math.round(value * 100);

/** Erhaltener Betrag fuer die Zahlung `index` von `amounts` (nur die letzte). */
export function amountReceivedFor(
  index: number,
  amounts: number[],
  amountReceived: number | undefined,
): number | undefined {
  if (amountReceived === undefined || index !== amounts.length - 1) {
    return undefined;
  }
  const coveredByOthers = amounts
    .slice(0, -1)
    .reduce((sum, amount) => sum + amount, 0);
  return round2(amountReceived - coveredByOthers);
}

/**
 * Verteilt `discount` von hinten nach vorn auf die Kapazitaeten.
 * Liefert je Position den angewandten Betrag; Rest verfaellt.
 */
export function distributeDiscount(
  capacities: number[],
  discount: number,
): number[] {
  let remaining = cents(discount);
  const applied = capacities.map(() => 0);
  for (let i = capacities.length - 1; i >= 0 && remaining > 0; i--) {
    const take = Math.min(Math.max(cents(capacities[i]), 0), remaining);
    applied[i] = take / 100;
    remaining -= take;
  }
  return applied;
}

function providerForMethod(method: PaymentMethod): PaymentProvider {
  switch (method) {
    case PaymentMethod.CARD:
      return PaymentProvider.CARD;
    case PaymentMethod.SUMUP_TERMINAL:
    case PaymentMethod.SUMUP_ONLINE:
      return PaymentProvider.SUMUP;
    default:
      return PaymentProvider.CASH;
  }
}

function mergeReason(
  existing: string | null,
  added: string | undefined,
): string | null {
  const next = added?.trim();
  if (!next) return existing;
  if (!existing) return next.slice(0, 255);
  return `${existing}; ${next}`.slice(0, 255);
}

export interface BatchPaymentResult {
  orders: Order[];
  payments: Payment[];
  totalPaid: number;
  change: number;
}

interface TransactionOutcome extends BatchPaymentResult {
  /** Bestellungen, deren Rabatt/Trinkgeld/Summe sich geaendert hat. */
  adjusted: Map<string, Record<string, unknown>>;
  /** Ohne Zahlung bezahlt (Rabatt deckt alles). */
  settledWithoutPayment: string[];
}

@Injectable()
export class PaymentsBatchService {
  private readonly logger = new Logger(PaymentsBatchService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject(forwardRef(() => GatewayService))
    private readonly gatewayService: GatewayService,
    private readonly orderPrintService: OrderPrintService,
  ) {}

  async payBatch(
    organizationId: string,
    deviceId: string,
    dto: BatchPaymentDto,
  ): Promise<BatchPaymentResult> {
    const provider = providerForMethod(dto.paymentMethod);
    const batchId = randomUUID();

    const outcome = await this.dataSource.transaction(async (manager) => {
      const organization = await manager.findOne(Organization, {
        where: { id: organizationId },
        select: { id: true, settings: true },
      });
      // SumUp nur bei eingeschalteter Integration; Bar/fremdes Kartengeraet
      // gehen immer.
      if (provider === PaymentProvider.SUMUP) {
        assertIntegrationEnabled(organization?.settings, 'sumup');
      }

      const locked = await manager.find(Order, {
        where: { id: In(dto.orderIds), organizationId },
        order: { id: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });
      const byId = new Map(locked.map((o) => [o.id, o]));
      const missing = dto.orderIds.filter((id) => !byId.has(id));
      if (missing.length) {
        throw new NotFoundException({
          code: ErrorCodes.NOT_FOUND,
          reason: ErrorReasons.ORDER_NOT_FOUND,
          message:
            missing.length === 1
              ? 'Eine der Bestellungen gibt es nicht (mehr).'
              : `${missing.length} der Bestellungen gibt es nicht (mehr).`,
          params: { orderIds: missing },
        });
      }
      // Reihenfolge der Anfrage: die letzte bekommt Trinkgeld/Bargeld.
      const orders = dto.orderIds.map((id) => byId.get(id)!);

      const cancelled = orders.filter(
        (o) => o.status === OrderStatus.CANCELLED,
      );
      if (cancelled.length) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.ORDER_ALREADY_CANCELLED,
          message:
            cancelled.length === 1
              ? `Bestellung ${cancelled[0].orderNumber} ist storniert und kann nicht kassiert werden.`
              : `${cancelled.length} Bestellungen sind storniert und können nicht kassiert werden.`,
          params: { orderIds: cancelled.map((o) => o.id) },
        });
      }

      const paid = orders.filter(
        (o) =>
          o.paymentStatus === PaymentStatus.PAID ||
          o.paymentStatus === PaymentStatus.REFUNDED,
      );
      if (paid.length) {
        throw new ConflictException({
          code: ErrorCodes.ORDER_ALREADY_PAID,
          reason: ErrorReasons.ORDER_ALREADY_PAID,
          message:
            'Mindestens eine Bestellung wurde gerade schon kassiert (z. B. an einem anderen Gerät). Lade die offenen Bestellungen neu.',
          params: { orderIds: paid.map((o) => o.id) },
        });
      }

      const items = await manager.find(OrderItem, {
        where: { orderId: In(dto.orderIds) },
      });
      const itemsOf = (orderId: string) =>
        items.filter((i) => i.orderId === orderId);

      const adjusted = new Map<string, Record<string, unknown>>();

      // Rabatt auf bereits angelegte Bestellungen.
      const discount = round2(dto.discountAmount ?? 0);
      if (discount > 0) {
        const capacities = orders.map((o) => {
          const open = Number(o.total) - Number(o.paidAmount);
          const discountable =
            Number(o.subtotal) - Number(o.discountAmount || 0);
          return round2(Math.max(0, Math.min(open, discountable)));
        });
        const applied = distributeDiscount(capacities, discount);
        orders.forEach((order, i) => {
          if (applied[i] <= 0) return;
          order.discountAmount = round2(
            Number(order.discountAmount || 0) + applied[i],
          );
          order.discountReason = mergeReason(
            order.discountReason,
            dto.discountReason,
          );
          order.total = round2(Number(order.total) - applied[i]);
          order.taxTotal = orderTaxTotal(
            itemsOf(order.id),
            order.discountAmount,
            organization?.settings?.vatExempt,
          );
          adjusted.set(order.id, {
            discountAmount: order.discountAmount,
            discountReason: order.discountReason,
            total: order.total,
            taxTotal: order.taxTotal,
          });
        });
      }

      // Trinkgeld auf die letzte Bestellung.
      const tip = round2(dto.tipAmount ?? 0);
      if (tip > 0) {
        const last = orders[orders.length - 1];
        last.tipAmount = round2(Number(last.tipAmount || 0) + tip);
        last.total = round2(Number(last.total) + tip);
        adjusted.set(last.id, {
          ...(adjusted.get(last.id) ?? {}),
          tipAmount: last.tipAmount,
          total: last.total,
        });
      }

      const due = orders.map((o) =>
        round2(Math.max(0, Number(o.total) - Number(o.paidAmount))),
      );
      const totalDue = round2(due.reduce((sum, amount) => sum + amount, 0));

      const isCash = dto.paymentMethod === PaymentMethod.CASH;
      if (
        isCash &&
        dto.amountReceived !== undefined &&
        cents(dto.amountReceived) < cents(totalDue)
      ) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.PAYMENT_AMOUNT_MISMATCH,
          message: `Gegeben (${dto.amountReceived.toFixed(2)} €) ist weniger als der offene Betrag (${totalDue.toFixed(2)} €).`,
          params: { expected: totalDue, received: dto.amountReceived },
        });
      }

      // Zahlungen nur fuer Bestellungen mit Restbetrag.
      const payable = orders
        .map((order, i) => ({ order, amount: due[i] }))
        .filter((p) => p.amount > 0);
      const payableAmounts = payable.map((p) => p.amount);

      const payments: Payment[] = [];
      payable.forEach(({ order, amount }, index) => {
        const received = isCash
          ? amountReceivedFor(index, payableAmounts, dto.amountReceived)
          : undefined;
        payments.push(
          manager.create(Payment, {
            orderId: order.id,
            amount,
            paymentMethod: dto.paymentMethod,
            paymentProvider: provider,
            providerTransactionId: dto.providerTransactionId ?? null,
            status: PaymentTransactionStatus.CAPTURED,
            metadata: {
              ...(dto.metadata ?? {}),
              batchId,
              batchOrderCount: orders.length,
              ...cashReceivedMetadata(dto.paymentMethod, amount, received),
            },
            processedByDeviceId: deviceId,
          }),
        );
      });
      if (payments.length) await manager.save(payments);

      const now = new Date();
      const settledWithoutPayment: string[] = [];
      orders.forEach((order, i) => {
        if (due[i] <= 0) settledWithoutPayment.push(order.id);
        order.paidAmount = round2(Number(order.paidAmount) + due[i]);
        order.paymentStatus =
          cents(Number(order.paidAmount)) >= cents(Number(order.total))
            ? PaymentStatus.PAID
            : order.paidAmount > 0
              ? PaymentStatus.PARTLY_PAID
              : PaymentStatus.UNPAID;

        // Wie die Einzelzahlung: Positionen als bezahlt markieren und nur
        // abschliessen, wenn kein Stationsablauf mehr laeuft.
        const orderItems = itemsOf(order.id);
        for (const item of orderItems) item.paidQuantity = item.quantity;
        const workflowDone = orderItems
          .filter((item) => item.status !== OrderItemStatus.CANCELLED)
          .every(
            (item) =>
              !item.productionStationId ||
              item.status === OrderItemStatus.DELIVERED,
          );
        if (workflowDone) {
          order.status = OrderStatus.COMPLETED;
          order.completedAt = now;
        }
      });
      if (items.length) await manager.save(items);
      await manager.save(orders);

      const reloaded = await manager.find(Order, {
        where: { id: In(dto.orderIds) },
        relations: ['items'],
      });
      const reloadedById = new Map(reloaded.map((o) => [o.id, o]));

      const totalPaid = round2(
        payments.reduce((sum, p) => sum + Number(p.amount), 0),
      );
      const change =
        isCash && dto.amountReceived !== undefined
          ? round2(Math.max(0, dto.amountReceived - totalPaid))
          : 0;

      return {
        orders: dto.orderIds.map((id) => reloadedById.get(id) ?? byId.get(id)!),
        payments,
        totalPaid,
        change,
        adjusted,
        settledWithoutPayment,
      } satisfies TransactionOutcome;
    });

    this.afterCommit(organizationId, outcome);

    this.logger.log(
      `Device ${deviceId} batch ${batchId}: ${outcome.payments.length} payment(s), ${outcome.totalPaid.toFixed(2)} over ${outcome.orders.length} order(s)`,
    );

    return {
      orders: outcome.orders,
      payments: outcome.payments,
      totalPaid: outcome.totalPaid,
      change: outcome.change,
    };
  }

  /** Echtzeit-Events und Bondruck erst nach dem Commit. */
  private afterCommit(organizationId: string, outcome: TransactionOutcome) {
    const orderById = new Map(outcome.orders.map((o) => [o.id, o]));

    for (const [orderId, changes] of outcome.adjusted) {
      const order = orderById.get(orderId);
      this.gatewayService.notifyOrderUpdated(
        organizationId,
        order?.eventId ?? null,
        orderId,
        changes,
      );
    }
    for (const orderId of outcome.settledWithoutPayment) {
      const order = orderById.get(orderId);
      if (!order) continue;
      this.gatewayService.notifyOrderUpdated(
        organizationId,
        order.eventId,
        orderId,
        { paymentStatus: order.paymentStatus, status: order.status },
      );
    }

    for (const payment of outcome.payments) {
      const order = orderById.get(payment.orderId);
      if (!order) continue;
      this.gatewayService.notifyPaymentReceived(organizationId, order.eventId, {
        orderId: order.id,
        orderNumber: order.orderNumber,
        paymentId: payment.id,
        amount: Number(payment.amount),
        paymentMethod: payment.paymentMethod,
        paidAmount: Number(order.paidAmount),
        totalAmount: Number(order.total),
        paymentStatus: order.paymentStatus,
      });

      // Bondruck wie bei der Einzelzahlung (Ausloeser payment_received).
      this.orderPrintService
        .handlePaymentReceived(organizationId, {
          orderId: order.id,
          orderNumber: order.orderNumber,
          paymentId: payment.id,
          amount: Number(payment.amount),
          paymentMethod: payment.paymentMethod,
          isFullyPaid: order.paymentStatus === PaymentStatus.PAID,
          order,
          amountReceived: payment.metadata?.amountReceived,
        })
        .catch((err) =>
          this.logger.error(
            `Auto-receipt on batch payment ${payment.id} failed: ${(err as Error).message}`,
          ),
        );
    }
  }
}
