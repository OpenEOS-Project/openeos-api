import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
  Optional,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, In, type EntityManager } from 'typeorm';
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
import { Event, EventStatus } from '../../database/entities/event.entity';
import { assertSumUpAllowedInMode } from '../../common/utils/sumup-test-mode.util';
import {
  Payment,
  PaymentMethod,
  PaymentProvider,
  PaymentTransactionStatus,
} from '../../database/entities/payment.entity';
import { GatewayService } from '../gateway/gateway.service';
import { assertIntegrationEnabled } from '../integrations/integration-catalog';
import {
  assertCashAllowed,
  OPERATING_MODE_SELECT,
} from '../../common/utils/operating-mode.util';
import { closedWithoutPaymentError } from '../orders/close-without-payment';
import { assertPaymentsAllowed } from '../../common/utils/operating-mode.util';
import { OrderPrintService } from '../print-jobs/order-print.service';
import { TseSigningService } from '../tse/tse-signing.service';
import type { TseReceiptView } from '../tse/tse-view';
import {
  cashReceivedMetadata,
  orderTaxTotal,
} from '../print-jobs/receipt-tax.util';
import {
  discountFactor,
  serviceFeeOf,
  unitGross,
} from '../refunds/refund-calc';
import { TokenType } from '../../database/entities/token-type.entity';
import {
  allocateTokens,
  assertTokensAllowed,
  paymentTokenLines,
  tokenNotEligibleError,
  tokenOverpaymentError,
  type TokenOrderInput,
} from '../tokens/token-rules';
import { BatchPaymentDto } from './dto/batch-payment.dto';
import { NO_ATTRIBUTION, type Attribution } from '../waiters/waiter-operator';

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
    case PaymentMethod.TOKENS:
      return PaymentProvider.TOKENS;
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

/** Gleiche Markentypen zusammenfassen (Stueckzahl addieren). */
export function mergeTenders(
  tenders: { tokenTypeId: string; count: number }[] | undefined,
): { tokenTypeId: string; count: number }[] {
  const byId = new Map<string, number>();
  for (const t of tenders ?? []) {
    const count = Math.round(Number(t.count) || 0);
    if (count <= 0) continue;
    byId.set(t.tokenTypeId, (byId.get(t.tokenTypeId) ?? 0) + count);
  }
  return [...byId.entries()].map(([tokenTypeId, count]) => ({
    tokenTypeId,
    count,
  }));
}

/**
 * Markentypen einer Kassierung laden: gibt es sie (404), sind sie aktiv
 * und gelten sie fuer die Veranstaltung der Bestellungen (400)?
 */
export async function loadTenderTypes(
  manager: EntityManager,
  organizationId: string,
  ids: string[],
  eventIds: (string | null)[],
): Promise<Map<string, TokenType>> {
  const found = await manager.find(TokenType, {
    where: { id: In(ids), organizationId },
  });
  const types = new Map(found.map((t) => [t.id, t]));
  const missing = ids.filter((id) => !types.has(id));
  if (missing.length) {
    throw new NotFoundException({
      code: ErrorCodes.NOT_FOUND,
      reason: ErrorReasons.TOKEN_TYPE_NOT_FOUND,
      message: 'Diesen Markentyp gibt es nicht (mehr).',
      params: { tokenTypeIds: missing },
    });
  }
  for (const type of types.values()) {
    if (!type.isActive) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.TOKEN_TYPE_INACTIVE,
        message: `${type.name} ist deaktiviert und wird gerade nicht angenommen.`,
        params: { tokenType: type.name },
      });
    }
    if (type.eventId && eventIds.some((e) => e && e !== type.eventId)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.TOKEN_NOT_ELIGIBLE,
        message: `${type.name} gilt nur für eine andere Veranstaltung.`,
        params: { tokenTypes: [type.name] },
      });
    }
  }
  return types;
}

/** Zahlung mit TSE-Daten ihres Kassenbelegs (null ohne aktive TSE). */
export type PaymentWithTse = Payment & { tse?: TseReceiptView | null };

export interface BatchPaymentResult {
  orders: Order[];
  /** Je Zahlung `tse` (Kassenbeleg) nach `afterCommit`. */
  payments: PaymentWithTse[];
  totalPaid: number;
  change: number;
}

export interface SettledBatch extends BatchPaymentResult {
  /** Bestellungen, deren Rabatt/Trinkgeld/Summe sich geaendert hat. */
  adjusted: Map<string, Record<string, unknown>>;
  /** Ohne Zahlung bezahlt (Rabatt deckt alles). */
  settledWithoutPayment: string[];
  /** Belege ueber 0,00 fuer `settledWithoutPayment` (nach `afterCommit`). */
  zeroReceipts?: TseReceiptView[];
  /** Kassenbelege schon signiert (`signSettled`), `afterCommit` signiert nicht erneut. */
  tseSigned?: boolean;
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
    @Optional()
    private readonly tseSigning?: TseSigningService,
  ) {}

  async payBatch(
    organizationId: string,
    deviceId: string,
    dto: BatchPaymentDto,
    attribution: Attribution = NO_ATTRIBUTION,
  ): Promise<BatchPaymentResult> {
    const outcome = await this.dataSource.transaction((manager) =>
      this.settle(manager, organizationId, deviceId, dto, attribution),
    );

    await this.afterCommit(organizationId, outcome, {
      deviceId,
      waiterId: attribution.waiterId,
      userId: attribution.userId,
    });

    return {
      orders: outcome.orders,
      payments: outcome.payments,
      totalPaid: outcome.totalPaid,
      change: outcome.change,
    };
  }

  /**
   * Die Sammelzahlung innerhalb einer laufenden Transaktion — fuer die
   * Kasse, die eine Bestellung zusammen mit ihrer Zahlung anlegt
   * (`POST /device-api/orders` mit `payment`). Danach `afterCommit`
   * aufrufen, erst dann gehen Ereignisse und Bons hinaus.
   */
  async settle(
    manager: EntityManager,
    organizationId: string,
    deviceId: string,
    dto: BatchPaymentDto,
    attribution: Attribution = NO_ATTRIBUTION,
  ): Promise<SettledBatch> {
    const provider = providerForMethod(dto.paymentMethod);
    const batchId = randomUUID();
    const organization = await manager.findOne(Organization, {
      where: { id: organizationId },
      select: OPERATING_MODE_SELECT,
    });
    // SumUp nur bei eingeschalteter Integration; fremdes Kartengeraet geht
    // immer, Bargeld nicht im bargeldlosen Modus (Trinkgeld und erhaltenes
    // Bargeld haengen an derselben Zahlart).
    // „Nur Bons“: keine Zahlung an der Kasse (403 ORDER_ONLY_MODE).
    assertPaymentsAllowed(organization);
    // Wertmarken: wie Bargeld eine Kassenfunktion — nur „Alle Funktionen“,
    // in Deutschland nur mit aktiver Cloud-TSE (Steuerberater 2026-11-10,
    // Frage 13). Vor der Pruefung des Geldes, damit die Meldung passt.
    const tokensOnly = dto.paymentMethod === PaymentMethod.TOKENS;
    const tenders = mergeTenders(dto.tokens);
    if (tenders.length > 0 || tokensOnly) {
      assertTokensAllowed(organization);
      if (tenders.length === 0) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.TOKEN_LINES_INVALID,
          message: 'Gib an, welche Wertmarken der Gast gegeben hat.',
        });
      }
    }
    if (provider === PaymentProvider.SUMUP) {
      assertIntegrationEnabled(organization?.settings, 'sumup');
    }
    if (!tokensOnly) assertCashAllowed(organization, dto.paymentMethod);

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

    // Testbestellungen: keine echte SumUp-Kartenzahlung buchen.
    if (dto.paymentMethod === PaymentMethod.SUMUP_TERMINAL) {
      // Testbestellung (Testmodus oder „Geplant“): Kennzeichen der Bestellung.
      if (orders.some((o) => o.isTest)) {
        assertSumUpAllowedInMode(EventStatus.TEST, dto.paymentMethod);
      }
      const eventIds = [
        ...new Set(orders.map((o) => o.eventId).filter(Boolean)),
      ] as string[];
      if (eventIds.length) {
        const events = await manager.find(Event, {
          where: { id: In(eventIds) },
          select: { id: true, status: true },
        });
        for (const event of events) {
          assertSumUpAllowedInMode(event.status, dto.paymentMethod);
        }
      }
    }

    const cancelled = orders.filter((o) => o.status === OrderStatus.CANCELLED);
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

    // „Ohne Zahlung abgeschlossen“ (bar ausserhalb kassiert): nichts mehr
    // zu kassieren.
    const closedOutside = orders.filter((o) => !!o.closedWithoutPaymentAt);
    if (closedOutside.length) {
      throw closedWithoutPaymentError(closedOutside.map((o) => o.id));
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
        const discountable = Number(o.subtotal) - Number(o.discountAmount || 0);
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
          serviceFeeOf(order),
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
    const requestedTip = round2(dto.tipAmount ?? 0);
    if (requestedTip > 0) {
      const last = orders[orders.length - 1];
      last.tipAmount = round2(Number(last.tipAmount || 0) + requestedTip);
      last.total = round2(Number(last.total) + requestedTip);
      adjusted.set(last.id, {
        ...(adjusted.get(last.id) ?? {}),
        tipAmount: last.tipAmount,
        total: last.total,
      });
    }

    const due = orders.map((o) =>
      round2(Math.max(0, Number(o.total) - Number(o.paidAmount))),
    );

    // Wertmarken zuerst: was sie decken duerfen, decken sie; den Rest
    // kassiert die Zahlart. Ueberzahlung nur als Trinkgeld (kein
    // Wechselgeld in Marken).
    const tokens = await this.allocateTenders(manager, {
      organizationId,
      organization,
      orders,
      itemsOf,
      due,
      tenders,
      excessAsTip: dto.tokenExcessAsTip === true,
      adjusted,
    });
    if (tokensOnly && tokens.moneyDueCents > 0) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.TOKEN_AMOUNT_INSUFFICIENT,
        message: `Die Marken reichen nicht: ${(tokens.moneyDueCents / 100).toFixed(2).replace('.', ',')} € sind noch offen. Kassiere den Rest bar oder mit Karte.`,
        params: { missing: tokens.moneyDueCents / 100 },
      });
    }
    const tokenCentsOf = (orderId: string) =>
      tokens.totalByOrder.get(orderId) ?? 0;
    const money = orders.map((o, i) =>
      round2(Math.max(0, cents(due[i]) - tokenCentsOf(o.id)) / 100),
    );
    const totalDue = round2(money.reduce((sum, amount) => sum + amount, 0));
    const tip = round2(Number(dto.tipAmount ?? 0) + tokens.tipAddedCents / 100);

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

    // Zahlungen nur fuer Bestellungen mit Restbetrag. `amount` ist das
    // Geld in der Zahlart, der Markenwert steht in `tokenAmount`; nur mit
    // Marken beglichen: Zahlart `tokens`, `amount` 0.
    const payable = orders
      .map((order, i) => ({
        order,
        amount: money[i],
        tokenCents: tokenCentsOf(order.id),
      }))
      .filter((p) => p.amount > 0 || p.tokenCents > 0);
    const moneyPayable = payable.filter((p) => p.amount > 0);
    const payableAmounts = moneyPayable.map((p) => p.amount);

    const payments: Payment[] = [];
    const tipOrderId = tip > 0 ? orders[orders.length - 1].id : null;
    payable.forEach(({ order, amount, tokenCents }) => {
      const moneyIndex = moneyPayable.findIndex((p) => p.order.id === order.id);
      const received =
        isCash && moneyIndex >= 0
          ? amountReceivedFor(moneyIndex, payableAmounts, dto.amountReceived)
          : undefined;
      const withMoney = amount > 0;
      const method = withMoney ? dto.paymentMethod : PaymentMethod.TOKENS;
      payments.push(
        manager.create(Payment, {
          orderId: order.id,
          amount,
          paymentMethod: method,
          paymentProvider: withMoney ? provider : PaymentProvider.TOKENS,
          providerTransactionId: withMoney
            ? (dto.providerTransactionId ?? null)
            : null,
          status: PaymentTransactionStatus.CAPTURED,
          metadata: {
            ...(dto.metadata ?? {}),
            batchId,
            batchOrderCount: orders.length,
            ...(withMoney
              ? cashReceivedMetadata(dto.paymentMethod, amount, received)
              : {}),
            ...(tokens.tipAddedCents > 0 && order.id === tipOrderId
              ? { tokenExcessAsTip: tokens.tipAddedCents / 100 }
              : {}),
          },
          processedByDeviceId: deviceId,
          // Wer kassiert: Bedienung bzw. Mitglied der Sitzung.
          processedByWaiterId: attribution.waiterId,
          processedByUserId: attribution.userId,
          // Trinkgeld dieser Kassierung haengt an der letzten Bestellung.
          tipAmount:
            order.id === tipOrderId
              ? Math.min(tip, round2(amount + tokenCents / 100))
              : 0,
          tokenAmount: tokenCents / 100,
          tokenLines: paymentTokenLines(
            tokens.perOrder.get(order.id),
            tokens.types,
            organization?.settings?.vatExempt,
          ),
        }),
      );
    });
    if (payments.length) {
      await manager.save(payments);
      // Gespeicherte Defaults kommen als Text zurueck (decimal): fuer die
      // Antwort wieder Zahlen.
      for (const p of payments) {
        p.amount = Number(p.amount);
        p.tokenAmount = Number(p.tokenAmount ?? 0);
        p.tipAmount = Number(p.tipAmount ?? 0);
      }
    }

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

    this.logger.log(
      `Device ${deviceId} batch ${batchId}: ${payments.length} payment(s), ${totalPaid.toFixed(2)} over ${orders.length} order(s)`,
    );

    return {
      orders: dto.orderIds.map((id) => reloadedById.get(id) ?? byId.get(id)!),
      payments,
      totalPaid,
      change,
      adjusted,
      settledWithoutPayment,
    } satisfies SettledBatch;
  }

  /**
   * Wertmarken einer Kassierung pruefen und auf die Bestellungen verteilen
   * (`allocateTokens`). Ueberzahlung: mit `excessAsTip` als Trinkgeld auf
   * die letzte Bestellung (der Gast verzichtet auf Wechselgeld), sonst
   * 400 TOKEN_OVERPAYMENT. Marken, die fuer die Artikel nicht gelten,
   * waehrend noch Geld offen ist: 400 TOKEN_NOT_ELIGIBLE.
   */
  private async allocateTenders(
    manager: EntityManager,
    input: {
      organizationId: string;
      organization: Organization | null;
      orders: Order[];
      itemsOf: (orderId: string) => OrderItem[];
      due: number[];
      tenders: { tokenTypeId: string; count: number }[];
      excessAsTip: boolean;
      adjusted: Map<string, Record<string, unknown>>;
    },
  ): Promise<{
    perOrder: Map<string, Map<string, number>>;
    totalByOrder: Map<string, number>;
    moneyDueCents: number;
    tipAddedCents: number;
    types: Map<string, TokenType>;
  }> {
    const empty = {
      perOrder: new Map<string, Map<string, number>>(),
      totalByOrder: new Map<string, number>(),
      moneyDueCents: input.due.reduce((s, d) => s + cents(d), 0),
      tipAddedCents: 0,
      types: new Map<string, TokenType>(),
    };
    if (input.tenders.length === 0) return empty;
    const types = await loadTenderTypes(
      manager,
      input.organizationId,
      input.tenders.map((t) => t.tokenTypeId),
      input.orders.map((o) => o.eventId),
    );
    const orderInputs: TokenOrderInput[] = input.orders.map((order, i) => {
      const items = input.itemsOf(order.id);
      const factor = discountFactor(items, order.discountAmount);
      return {
        id: order.id,
        dueCents: cents(input.due[i]),
        items: items
          .filter((item) => item.status !== OrderItemStatus.CANCELLED)
          .map((item) => {
            const open = Math.max(0, item.quantity - (item.paidQuantity || 0));
            return {
              id: item.id,
              productId: item.productId,
              categoryId: item.categoryId,
              taxRate: item.taxRate,
              status: item.status,
              openCents: Math.round(cents(unitGross(item)) * open * factor),
              depositCents: cents(item.depositAmount || 0) * open,
            };
          }),
      };
    });
    const allocation = allocateTokens(
      orderInputs,
      input.tenders.map((t) => ({
        type: types.get(t.tokenTypeId)!,
        count: t.count,
      })),
    );
    let tipAddedCents = 0;
    if (allocation.excessCents > 0) {
      if (allocation.moneyDueCents > 0) {
        throw tokenNotEligibleError(
          [...allocation.excessByType.keys()].map(
            (id) => types.get(id)?.name ?? id,
          ),
          allocation.excessCents,
        );
      }
      if (!input.excessAsTip)
        throw tokenOverpaymentError(allocation.excessCents);
      // Rest als Trinkgeld der letzten Bestellung, bezahlt mit den Marken.
      tipAddedCents = allocation.excessCents;
      const last = input.orders[input.orders.length - 1];
      const lastIndex = input.orders.length - 1;
      last.tipAmount = round2(
        Number(last.tipAmount || 0) + tipAddedCents / 100,
      );
      last.total = round2(Number(last.total) + tipAddedCents / 100);
      input.due[lastIndex] = round2(input.due[lastIndex] + tipAddedCents / 100);
      input.adjusted.set(last.id, {
        ...(input.adjusted.get(last.id) ?? {}),
        tipAmount: last.tipAmount,
        total: last.total,
      });
      const byType =
        allocation.perOrder.get(last.id) ?? new Map<string, number>();
      for (const [typeId, value] of allocation.excessByType) {
        byType.set(typeId, (byType.get(typeId) ?? 0) + value);
      }
      allocation.perOrder.set(last.id, byType);
      allocation.totalByOrder.set(
        last.id,
        (allocation.totalByOrder.get(last.id) ?? 0) + tipAddedCents,
      );
    }
    return {
      perOrder: allocation.perOrder,
      totalByOrder: allocation.totalByOrder,
      moneyDueCents: allocation.moneyDueCents,
      tipAddedCents,
      types,
    };
  }

  /**
   * Kassenbelege der Zahlungen (und Belege ueber 0,00) ueber die Cloud-TSE
   * signieren — parallel, mit Zeitbudget, nie blockierend. Laeuft vor jedem
   * Kuechenbon, damit es keine Kuechenbons ohne TSE-Spur gibt (Steuerberater
   * 2026-11-10, Frage 19) und vor dem Kassenbon (Frage 16). Setzt
   * `payment.tse`, `zeroReceipts` und `tseSigned`.
   */
  async signSettled(
    outcome: SettledBatch,
    actor: {
      deviceId?: string | null;
      waiterId?: string | null;
      userId?: string | null;
    } = {},
  ): Promise<void> {
    const tseSigning = this.tseSigning;
    const [signed, zeroReceipts] = tseSigning
      ? await Promise.all([
          tseSigning.signPayments(outcome.payments.map((p) => p.id)),
          Promise.all(
            outcome.settledWithoutPayment.map((orderId) =>
              tseSigning.signZeroReceipt(orderId, {
                terminal: actor.deviceId ?? null,
                waiterId: actor.waiterId ?? null,
                userId: actor.userId ?? null,
              }),
            ),
          ),
        ])
      : [new Map<string, TseReceiptView>(), [] as Array<TseReceiptView | null>];
    for (const payment of outcome.payments) {
      payment.tse = signed.get(payment.id) ?? null;
    }
    outcome.zeroReceipts = zeroReceipts.filter(
      (view): view is TseReceiptView => view !== null,
    );
    outcome.tseSigned = true;
  }

  /**
   * Nach dem Commit: zuerst die Kassenbelege ueber die Cloud-TSE
   * signieren (falls aktiv; parallel, mit Zeitbudget, nie blockierend),
   * dann Echtzeit-Events und Bondruck mit den TSE-Daten. Die Zahlungen im
   * Ergebnis bekommen `tse` (Vertrag: tse-swissbit-plan.md §8).
   */
  async afterCommit(
    organizationId: string,
    outcome: SettledBatch,
    actor: {
      deviceId?: string | null;
      waiterId?: string | null;
      userId?: string | null;
    } = {},
  ): Promise<void> {
    const orderById = new Map(outcome.orders.map((o) => [o.id, o]));
    if (!outcome.tseSigned) await this.signSettled(outcome, actor);
    const signed = new Map<string, TseReceiptView>();
    for (const payment of outcome.payments) {
      const tse = (payment as { tse?: TseReceiptView | null }).tse;
      if (tse) signed.set(payment.id, tse);
    }

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
          tse: signed.get(payment.id) ?? null,
        })
        .catch((err) =>
          this.logger.error(
            `Auto-receipt on batch payment ${payment.id} failed: ${(err as Error).message}`,
          ),
        );
    }
  }
}
