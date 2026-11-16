import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
  Optional,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, type EntityManager } from 'typeorm';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { TseSigningService } from '../tse/tse-signing.service';
import type { TseReceiptView } from '../tse/tse-view';
import {
  Device,
  Event,
  Order,
  OrderEvent,
  OrderItem,
  Organization,
  Payment,
  Product,
  Refund,
  RefundItem,
  StockMovement,
  User,
  UserOrganization,
} from '../../database/entities';
import { EventStatus } from '../../database/entities/event.entity';
import {
  OrderStatus,
  PaymentStatus,
} from '../../database/entities/order.entity';
import { OrderItemStatus } from '../../database/entities/order-item.entity';
import {
  PaymentMethod,
  PaymentProvider,
  PaymentTransactionStatus,
  type PaymentTokenLine,
} from '../../database/entities/payment.entity';
import type {
  RefundKind,
  RefundStatus,
} from '../../database/entities/refund.entity';
import type { OrderEventType } from '../../database/entities/order-event.entity';
import { StockMovementType } from '../../database/entities/stock-movement.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { GatewayService } from '../gateway/gateway.service';
import { isIntegrationEnabled } from '../integrations/integration-catalog';
import {
  assertCashAllowed,
  OPERATING_MODE_SELECT,
  isCashAllowed,
  isCashlessPaymentMethod,
  isOnlinePrepaymentMethod,
  isOrdersOnly,
  orderOnlyModeError,
} from '../../common/utils/operating-mode.util';
import {
  OrderPrintService,
  refundReasonLabel,
} from '../print-jobs/order-print.service';
import { orderTaxTotal } from '../print-jobs/receipt-tax.util';
import { SumUpApiService } from '../sumup/sumup-api.service';
import type { Operator } from '../waiters/waiter-operator';
import { WaiterSessionsService } from '../waiters/waiter-sessions.service';
import type {
  CancelItemsDto,
  CancelOrderWithActorDto,
  CreateRefundDto,
  DeviceActorDto,
  RefundItemSelectionDto,
} from './dto/refund.dto';
import {
  OrderHistoryService,
  type OrderHistoryDetail,
} from './order-history.service';
import {
  addComposition,
  allocateRefundFor,
  amountComposition,
  cents,
  compositionTotal,
  depositRateOf,
  emptyComposition,
  itemsRefund,
  orderComposition,
  pfandFromRecord,
  pfandSum,
  rateMapFrom,
  rateRecord,
  refundTaxLines,
  tipByRate,
  round2,
  scaleComposition,
  serviceFeeOf,
  subtractComposition,
  unitGross,
  type Composition,
  type RefundablePayment,
} from './refund-calc';

type RefundPermission = 'allowed' | 'pin' | 'disabled';

/** Wer storniert/erstattet (Kasse oder Verwaltung). */
export interface RefundActor {
  organizationId: string;
  deviceId: string | null;
  deviceName: string | null;
  userId: string | null;
  /** Ausloesende Bedienung (Bedienungs-Sitzung an der Kasse). */
  waiterId?: string | null;
  actorName: string | null;
  /** Freigabe per PIN (Schichtleitung bzw. Mitglied mit Recht „Bestellungen“). */
  approvedByWaiterId?: string | null;
  approvedByUserId?: string | null;
  /** Kassenlade bei Barerstattung oeffnen (Geraeteeinstellung). */
  cashDrawerPrinterId: string | null;
}

interface CancelLine {
  item: OrderItem;
  /** Zeile mit der stornierten Menge (bei Teilmenge eine neue Zeile). */
  cancelled: OrderItem;
  quantity: number;
  started: boolean;
  restocked: boolean;
  /** Status vor dem Storno (Storno-Bon nur fuer Positionen in der Kueche). */
  previousStatus: OrderItemStatus;
}

interface CancelResult {
  lines: CancelLine[];
  restockedProducts: Product[];
  orderCancelled: boolean;
}

export interface CancelOutcome {
  order: Order;
  cancelled: CancelResult;
  reason: string | null;
}

export interface RefundOutcome {
  order: Order;
  refunds: Refund[];
  cancelled: CancelResult | null;
  reason: string | null;
}

/** SumUp lehnt ab: Transaktion zurueckrollen, Versuch protokollieren. */
class RefundProviderError extends Error {
  constructor(
    readonly paymentId: string,
    readonly amount: number,
    readonly response: unknown,
  ) {
    super('refund provider failed');
  }
}

const STARTED = new Set<string>([
  OrderItemStatus.PREPARING,
  OrderItemStatus.READY,
  OrderItemStatus.DELIVERED,
]);

function fullName(user?: Pick<User, 'firstName' | 'lastName'> | null) {
  if (!user) return null;
  const name = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
  return name || null;
}

/** Summen der Bestellung aus den (in-memory) Positionen, wie beim Anlegen. */
export function recalcOrderTotals(
  order: Order,
  items: OrderItem[],
  vatExempt: boolean | undefined,
): void {
  let subtotal = 0;
  let pfandTotal = 0;
  for (const item of items) {
    if (item.status === OrderItemStatus.CANCELLED) continue;
    subtotal += Number(item.totalPrice);
    pfandTotal += Number(item.depositAmount || 0) * item.quantity;
  }
  subtotal = round2(subtotal);
  pfandTotal = round2(pfandTotal);
  const discount = Math.min(Number(order.discountAmount || 0), subtotal);
  order.subtotal = subtotal;
  order.pfandTotal = pfandTotal;
  order.discountAmount = round2(discount);
  // Die Servicegebuehr (Shop) bleibt Teil der Bestellung.
  order.total = round2(
    subtotal -
      discount +
      Number(order.tipAmount || 0) +
      pfandTotal +
      Number(order.serviceFee || 0),
  );
  order.taxTotal = orderTaxTotal(
    items,
    discount,
    vatExempt,
    serviceFeeOf(order),
  );
}

/**
 * Storno und Erstattung (Kasse und Verwaltung).
 *
 * - Positionen stornieren, solange die Kueche nicht begonnen hat: Bestand
 *   zurueck, Station entfernt sie live, Storno-Bon an den Stationsdrucker.
 *   Schon begonnene Positionen nur mit ausdruecklicher Bestaetigung und
 *   Grund (Ausschuss, kein Bestand zurueck).
 * - Bezahlte Bestellungen nur mit Erstattung stornieren
 *   (ORDER_PAID_REFUND_REQUIRED).
 * - Jede Erstattung ist ein eigener Gegenbeleg mit negativen Betraegen,
 *   MwSt je Satz und Bezug auf Bestellung und Zahlung; Rueckgabeweg je
 *   Zahlart (bar: Kassenlade, SumUp: Erstattung ueber die SumUp-API,
 *   fremdes Kartengeraet: manuell). Im Testmodus wird bei SumUp nichts
 *   ausgeloest.
 * - Alles in einer Transaktion mit gesperrter Bestellung; Ereignisse,
 *   Kassenlade und Druck erst nach dem Commit.
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(UserOrganization)
    private readonly memberRepository: Repository<UserOrganization>,
    @InjectRepository(Refund)
    private readonly refundRepository: Repository<Refund>,
    @InjectRepository(OrderEvent)
    private readonly orderEventRepository: Repository<OrderEvent>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    private readonly sumUpApiService: SumUpApiService,
    private readonly orderPrintService: OrderPrintService,
    @Inject(forwardRef(() => GatewayService))
    private readonly gatewayService: GatewayService,
    private readonly orderHistoryService: OrderHistoryService,
    @Optional()
    private readonly tseSigning?: TseSigningService,
    @Optional()
    private readonly waiterSessions?: WaiterSessionsService,
  ) {}

  // ---------------------------------------------------------------------
  // Berechtigung
  // ---------------------------------------------------------------------

  /**
   * Prueft die Geraeteeinstellung „Stornieren & Erstatten“ und liefert,
   * wer die Aktion ausloest (bedienungen-plan.md §6).
   *
   * - `disabled`: nie.
   * - Mit Bedienungs-Sitzung (`operator`): mit Recht `refund` direkt,
   *   sonst gibt eine Schichtleitung bzw. ein Mitglied mit Recht
   *   „Bestellungen“ (oder Admin) per PIN frei (`approved_by_*`).
   * - Ohne Sitzung (Modus `off`): `pin` verlangt die PIN einer berechtigten
   *   Person, die dann als Ausloeser gilt; `allowed` ohne PIN.
   * - `operatorUserId` aus dem Body wird ignoriert: die Zuordnung kommt nur
   *   aus der Sitzung.
   */
  async resolveDeviceActor(
    device: Device,
    body: DeviceActorDto,
    operator: Operator | null = null,
  ): Promise<RefundActor> {
    const organizationId = device.organizationId!;
    const policy = (device.settings?.refundPermission ??
      'allowed') as RefundPermission;
    const base: RefundActor = {
      organizationId,
      deviceId: device.id,
      deviceName: device.name,
      userId: operator?.userId ?? null,
      waiterId: operator?.waiterId ?? null,
      actorName: operator?.name ?? null,
      cashDrawerPrinterId:
        (device.settings?.cashDrawerPrinterId as string | undefined) ?? null,
    };

    if (policy === 'disabled') {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.REFUND_NOT_ALLOWED,
        message:
          'Stornieren und Erstatten ist an dieser Kasse ausgeschaltet. Nutze eine andere Kasse oder die Verwaltung.',
      });
    }

    if (operator) {
      if (operator.permissions.refund) return base;
      const approver = await this.approverByPin(device, body.pin);
      return {
        ...base,
        approvedByWaiterId: approver.waiterId,
        approvedByUserId: approver.userId,
      };
    }

    if (policy === 'pin' || body.pin) {
      const approver = await this.approverByPin(
        device,
        body.pin,
        policy === 'pin',
      );
      return {
        ...base,
        userId: approver.userId,
        waiterId: approver.waiterId,
        actorName: approver.name,
      };
    }
    return base;
  }

  /** PIN einer Freigabe pruefen (mit Sperre nach Fehlversuchen). */
  private async approverByPin(
    device: Device,
    pin: string | undefined,
    requireRight = true,
  ): Promise<Operator> {
    if (!pin) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.REFUND_PIN_REQUIRED,
        message: 'Für Storno und Erstattung ist eine PIN nötig.',
      });
    }
    if (!this.waiterSessions) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.PIN_INVALID,
        message: 'Ungültige PIN',
      });
    }
    const approver = await this.waiterSessions.verifyApprover(device, pin);
    if (requireRight && !approver.permissions.refund) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.REFUND_PIN_NOT_AUTHORIZED,
        message:
          'Diese PIN darf nicht stornieren oder erstatten. Nötig ist eine Schichtleitung, das Recht „Bestellungen“ oder Admin.',
      });
    }
    return approver;
  }

  /** Verwaltung: Admin oder Recht „Bestellungen“. */
  async resolveAdminActor(
    organizationId: string,
    user: User,
  ): Promise<RefundActor> {
    const member = await this.memberRepository.findOne({
      where: { organizationId, userId: user.id },
      relations: ['user'],
    });
    if (!member) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.ORGANIZATION_ACCESS_DENIED,
        message: 'Kein Zugriff auf diese Organisation',
      });
    }
    if (!this.mayRefund(member)) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.REFUND_PIN_NOT_AUTHORIZED,
        message:
          'Zum Stornieren und Erstatten brauchst du das Recht „Bestellungen“ oder Admin.',
      });
    }
    return {
      organizationId,
      deviceId: null,
      deviceName: null,
      userId: user.id,
      actorName: fullName(member.user ?? user),
      cashDrawerPrinterId: null,
    };
  }

  private mayRefund(member: UserOrganization): boolean {
    return (
      member.role === OrganizationRole.ADMIN ||
      member.permissions?.orders === true
    );
  }

  // ---------------------------------------------------------------------
  // Storno
  // ---------------------------------------------------------------------

  /** Positionen (oder Teilmengen) stornieren, ohne Erstattung. */
  async cancelItems(
    actor: RefundActor,
    orderId: string,
    dto: CancelItemsDto,
  ): Promise<CancelOutcome> {
    const reason = refundReasonLabel(dto.reasonCode, dto.reasonText);
    const outcome = await this.dataSource.transaction(async (manager) => {
      const { order, items, vatExempt } = await this.lockOrder(
        manager,
        actor.organizationId,
        orderId,
      );
      if (order.status === OrderStatus.CANCELLED) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.ORDER_ALREADY_CANCELLED,
          message: 'Bestellung ist bereits storniert',
        });
      }
      const plan = this.planCancellation(items, dto.items, {
        confirmStarted: dto.confirmStarted === true,
        hasReason: !!dto.reasonCode,
      });
      const cancelled = await this.applyCancellation(
        manager,
        order,
        items,
        plan,
        actor,
        reason,
        vatExempt,
      );

      const held = cents(order.paidAmount) - cents(order.refundedAmount || 0);
      if (cents(order.total) < held) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.ORDER_PAID_REFUND_REQUIRED,
          message:
            'Diese Positionen sind schon bezahlt. Storniere sie mit Erstattung.',
          params: { refundAmount: (held - cents(order.total)) / 100 },
        });
      }
      this.finishOrderState(order, items, cancelled, reason);
      await manager.save(order);
      await this.recordEvent(manager, actor, order.id, 'items_cancelled', {
        items: cancelled.lines.map((l) => ({
          orderItemId: l.cancelled.id,
          productName: l.item.productName,
          quantity: l.quantity,
          started: l.started,
          restocked: l.restocked,
        })),
        reasonCode: dto.reasonCode ?? null,
        reasonText: dto.reasonText ?? null,
        orderCancelled: cancelled.orderCancelled,
      });
      return { order, cancelled, reason };
    });

    this.afterCancellation(actor, outcome.order, outcome.cancelled, reason);
    this.notifyOrder(actor.organizationId, outcome.order);
    return outcome;
  }

  /**
   * Ganze Bestellung stornieren (ohne Erstattung). Bezahlte Bestellungen
   * nur ueber `createRefund` mit `mode: full, cancelItems: true`.
   */
  async cancelOrder(
    actor: RefundActor,
    orderId: string,
    dto: CancelOrderWithActorDto,
  ): Promise<CancelOutcome> {
    const reason =
      refundReasonLabel(dto.reasonCode, dto.reason) ?? dto.reason ?? null;
    const outcome = await this.dataSource.transaction(async (manager) => {
      const { order, items, vatExempt } = await this.lockOrder(
        manager,
        actor.organizationId,
        orderId,
      );
      if (order.status !== OrderStatus.CANCELLED) {
        const held = cents(order.paidAmount) - cents(order.refundedAmount || 0);
        if (held > 0) {
          throw new BadRequestException({
            code: ErrorCodes.VALIDATION_ERROR,
            reason: ErrorReasons.ORDER_PAID_REFUND_REQUIRED,
            message:
              'Die Bestellung ist (teilweise) bezahlt. Storniere sie mit Erstattung.',
            params: { refundAmount: held / 100 },
          });
        }
      }
      if (
        order.status === OrderStatus.CANCELLED ||
        order.status === OrderStatus.COMPLETED
      ) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.ORDER_CANNOT_BE_CANCELLED,
          message:
            'Bestellung kann nicht storniert werden (bereits abgeschlossen oder storniert)',
        });
      }
      const active = items.filter(
        (i) => i.status !== OrderItemStatus.CANCELLED,
      );
      const plan = this.planCancellation(
        items,
        active.map((i) => ({ orderItemId: i.id, quantity: i.quantity })),
        // Die ganze Bestellung wird an der Kasse ausdruecklich bestaetigt.
        { confirmStarted: true, hasReason: true },
      );
      const cancelled = await this.applyCancellation(
        manager,
        order,
        items,
        plan,
        actor,
        reason,
        vatExempt,
      );
      this.finishOrderState(order, items, cancelled, reason, true);
      await manager.save(order);
      await this.recordEvent(manager, actor, order.id, 'order_cancelled', {
        reasonCode: dto.reasonCode ?? null,
        reasonText: dto.reason ?? null,
        items: cancelled.lines.map((l) => ({
          productName: l.item.productName,
          quantity: l.quantity,
          started: l.started,
          restocked: l.restocked,
        })),
      });
      return { order, cancelled, reason };
    });

    this.afterCancellation(actor, outcome.order, outcome.cancelled, reason);
    this.notifyOrder(actor.organizationId, outcome.order);
    return outcome;
  }

  // ---------------------------------------------------------------------
  // Erstattung
  // ---------------------------------------------------------------------

  async createRefund(
    actor: RefundActor,
    orderId: string,
    dto: CreateRefundDto,
  ): Promise<RefundOutcome> {
    if (dto.clientRequestId) {
      const existing = await this.refundRepository.find({
        where: {
          organizationId: actor.organizationId,
          clientRequestId: dto.clientRequestId,
        },
        relations: ['items'],
      });
      if (existing.length) {
        const order = await this.orderRepository.findOneOrFail({
          where: { id: existing[0].orderId },
        });
        return { order, refunds: existing, cancelled: null, reason: null };
      }
    }
    if (dto.mode === 'items' && !dto.items?.length) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.REFUND_ITEMS_REQUIRED,
        message: 'Wähle mindestens eine Position.',
      });
    }
    if (dto.mode === 'amount' && !dto.amount) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.REFUND_AMOUNT_INVALID,
        message: 'Gib einen Betrag größer 0 ein.',
      });
    }

    const reason = refundReasonLabel(dto.reasonCode, dto.reasonText);
    let outcome: RefundOutcome;
    try {
      outcome = await this.dataSource.transaction((manager) =>
        this.refundInTransaction(manager, actor, orderId, dto, reason),
      );
    } catch (error) {
      if (error instanceof RefundProviderError) {
        await this.recordFailure(actor, orderId, error, dto);
        const response = error.response as {
          message?: string;
          errorType?: string;
          details?: { code?: string; message?: string }[];
        };
        throw new BadRequestException({
          code: ErrorCodes.SUMUP_API_ERROR,
          reason: ErrorReasons.REFUND_PROVIDER_FAILED,
          message:
            'SumUp hat die Erstattung abgelehnt. Prüfe die Meldung oder buche die Erstattung als manuell erstattet.',
          params: {
            paymentId: error.paymentId,
            amount: error.amount,
            providerError: response?.errorType ?? null,
            providerMessage:
              response?.details?.[0]?.message ?? response?.message ?? null,
            providerStatus: response?.details?.[0]?.code ?? null,
          },
        });
      }
      throw error;
    }

    if (outcome.cancelled) {
      this.afterCancellation(actor, outcome.order, outcome.cancelled, reason);
    }
    this.notifyOrder(actor.organizationId, outcome.order);
    await this.afterRefund(actor, outcome);
    return outcome;
  }

  private async refundInTransaction(
    manager: EntityManager,
    actor: RefundActor,
    orderId: string,
    dto: CreateRefundDto,
    reason: string | null,
  ): Promise<RefundOutcome> {
    const { order, items, vatExempt, organization, isTestMode } =
      await this.lockOrder(manager, actor.organizationId, orderId);

    const payments = await manager.find(Payment, {
      where: { orderId: order.id },
      order: { createdAt: 'ASC' },
    });
    const priorRefunds = await manager.find(Refund, {
      where: { orderId: order.id },
    });
    // Erstattet je Zahlung, getrennt nach Geld und zurueckgegebenen
    // Wertmarken (Erstattungen mit Zahlart `tokens`).
    const refundedByPayment = new Map<string, number>();
    const refundedTokensByPayment = new Map<string, number>();
    for (const r of priorRefunds) {
      if (!r.paymentId) continue;
      const target =
        r.paymentMethod === PaymentMethod.TOKENS
          ? refundedTokensByPayment
          : refundedByPayment;
      target.set(r.paymentId, (target.get(r.paymentId) ?? 0) - cents(r.amount));
    }
    const held = cents(order.paidAmount) - cents(order.refundedAmount || 0);
    if (held <= 0) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.REFUND_NOTHING_TO_REFUND,
        message: 'Für diese Bestellung ist nichts mehr zu erstatten.',
      });
    }

    // Was ist noch „verkauft“: aktuelle Zusammensetzung abzueglich der
    // Kulanz-Erstattungen (Storno-Erstattungen stecken schon in der Summe).
    const before = orderComposition(items, order);
    let goodwill = emptyComposition();
    for (const r of priorRefunds) {
      if (r.kind !== 'refund') continue;
      goodwill = addComposition(goodwill, compositionFromMetadata(r.metadata));
    }
    const remaining = subtractComposition(before, goodwill);

    let kind: RefundKind = 'refund';
    let composition: Composition;
    let refundCents: number;
    let lines: {
      item: OrderItem;
      quantity: number;
      goods: number;
      deposit: number;
      cancelled: boolean;
    }[] = [];
    let cancelled: CancelResult | null = null;

    if (dto.mode === 'amount') {
      refundCents = cents(dto.amount ?? 0);
      if (refundCents > held) throw this.exceeds(held);
      composition = amountComposition(remaining, refundCents);
    } else if (dto.cancelItems) {
      kind = 'cancellation';
      const selections =
        dto.mode === 'full'
          ? items
              .filter((i) => i.status !== OrderItemStatus.CANCELLED)
              .map((i) => ({ orderItemId: i.id, quantity: i.quantity }))
          : (dto.items ?? []);
      const plan = this.planCancellation(items, selections, {
        confirmStarted: dto.confirmStarted === true,
        hasReason: true,
      });
      const snapshot = items.map((i) => ({ ...i }) as OrderItem);
      const lineInfo = itemsRefund(
        snapshot,
        plan.map((p) => ({
          item: snapshot.find((s) => s.id === p.item.id)!,
          quantity: p.quantity,
        })),
        order.discountAmount,
        true,
      );
      cancelled = await this.applyCancellation(
        manager,
        order,
        items,
        plan,
        actor,
        reason,
        vatExempt,
      );
      const after = orderComposition(items, order);
      // Bei `full` geht alles zurueck, was noch gehalten wird (inkl.
      // Trinkgeld); sonst der Teil, den die neue Summe nicht mehr deckt.
      refundCents =
        dto.mode === 'full' ? held : Math.max(0, held - cents(order.total));
      const diff =
        dto.mode === 'full' ? remaining : subtractComposition(before, after);
      composition = scaleComposition(diff, refundCents);
      lines = lineInfo.lines.map((l, index) => ({
        item: cancelled!.lines[index]?.cancelled ?? l.item,
        quantity: l.quantity,
        goods: l.goods,
        deposit: l.deposit,
        cancelled: true,
      }));
    } else if (dto.mode === 'full') {
      refundCents = held;
      composition = scaleComposition(remaining, refundCents);
      for (const item of items) {
        if (item.status === OrderItemStatus.CANCELLED) continue;
        const open = item.quantity - (item.refundedQuantity || 0);
        if (open <= 0) continue;
        lines.push({
          item,
          quantity: open,
          goods: 0,
          deposit: 0,
          cancelled: false,
        });
        item.refundedQuantity = item.quantity;
      }
    } else {
      const selections = this.resolveSelections(items, dto.items ?? []);
      for (const { item, quantity } of selections) {
        const open = item.quantity - (item.refundedQuantity || 0);
        if (item.status === OrderItemStatus.CANCELLED || quantity > open) {
          throw new BadRequestException({
            code: ErrorCodes.VALIDATION_ERROR,
            reason: ErrorReasons.REFUND_QUANTITY_EXCEEDED,
            message: `Von ${item.productName} sind nur noch ${Math.max(0, open)} erstattbar.`,
            params: { product: item.productName, max: Math.max(0, open) },
          });
        }
      }
      const result = itemsRefund(
        items,
        selections,
        order.discountAmount,
        dto.includeDeposit !== false,
      );
      composition = result.composition;
      refundCents = compositionTotal(composition);
      if (refundCents > held) throw this.exceeds(held);
      lines = result.lines.map((l) => ({ ...l, cancelled: false }));
      for (const { item, quantity } of selections) {
        item.refundedQuantity = (item.refundedQuantity || 0) + quantity;
      }
    }

    if (items.length) await manager.save(items);

    // Storno des unbezahlten Teils: keine Erstattung noetig.
    if (refundCents <= 0) {
      if (!cancelled) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.REFUND_NOTHING_TO_REFUND,
          message: 'Für diese Auswahl ist nichts zu erstatten.',
        });
      }
      this.finishOrderState(order, items, cancelled, reason);
      await manager.save(order);
      await this.recordEvent(manager, actor, order.id, 'items_cancelled', {
        items: cancelled.lines.map((l) => ({
          productName: l.item.productName,
          quantity: l.quantity,
          started: l.started,
          restocked: l.restocked,
        })),
        reasonCode: dto.reasonCode,
        reasonText: dto.reasonText ?? null,
      });
      return { order, refunds: [], cancelled, reason };
    }

    // Auf Zahlungen verteilen. „Nur Bons“: nur zurueck auf eine
    // Online-Vorauszahlung des Gastes (Shop/QR, aus der Zeit vor dem
    // Wechsel), nie aus einer Kasse.
    const orderOnly = isOrdersOnly(organization);
    const settledPayments = payments.filter(
      (p) =>
        p.status === PaymentTransactionStatus.CAPTURED ||
        p.status === PaymentTransactionStatus.REFUNDED,
    );
    const refundable = settledPayments
      .filter((p) => !orderOnly || isOnlinePrepaymentMethod(p.paymentMethod))
      .flatMap((p) => {
        const buckets: RefundablePayment[] = [];
        if (p.paymentMethod !== PaymentMethod.TOKENS) {
          buckets.push({
            id: p.id,
            refundable: Math.max(
              0,
              cents(p.amount) - (refundedByPayment.get(p.id) ?? 0),
            ),
            isProvider: isSumUpTerminal(p),
            createdAt: new Date(p.createdAt),
            // Bargeld und alles ausserhalb der Positivliste fuer
            // „Bargeldlos“: nie dorthin erstatten, wo Bargeld gesperrt ist.
            // Erstattet wird immer auf die urspruengliche Zahlart, eine
            // Auszahlung in bar gibt es nicht.
            isCash: !isCashlessPaymentMethod(p.paymentMethod),
          });
        }
        // Mit Wertmarken bezahlter Teil: geht als Marken zurueck (nie als
        // Geld — sonst waere die Marke eine Guthabenkarte). Nach dem Geld
        // derselben Zahlung (eine Millisekunde aelter), wie Bargeld
        // gesperrt, wo Marken nicht erlaubt sind.
        if (cents(p.tokenAmount ?? 0) > 0) {
          buckets.push({
            id: `${TOKEN_BUCKET}${p.id}`,
            refundable: Math.max(
              0,
              cents(p.tokenAmount) - (refundedTokensByPayment.get(p.id) ?? 0),
            ),
            isProvider: false,
            createdAt: new Date(new Date(p.createdAt).getTime() - 1),
            isCash: true,
          });
        }
        return buckets;
      });
    // Gewaehlte Zahlung: ihr Geld und ihre Marken.
    const candidates = dto.paymentId
      ? refundable.filter(
          (b) =>
            b.id === dto.paymentId ||
            b.id === `${TOKEN_BUCKET}${dto.paymentId}`,
        )
      : refundable;
    // Bargeld gesperrt (Betriebsart ohne Bargeld oder DE ohne TSE):
    // nichts bar auszahlen. Erstattet wird nur auf
    // unbare Zahlungen (Karte, SumUp, online) — reichen die nicht, wird
    // abgewiesen statt den Rest aus der Kasse zu geben.
    const { allocation, cashBlocked } = allocateRefundFor(
      candidates,
      refundCents,
      null,
      !isCashAllowed(organization),
    );
    if (cashBlocked) {
      assertCashAllowed(organization, PaymentMethod.CASH);
    }
    if (
      !allocation &&
      orderOnly &&
      settledPayments.some((p) => !isOnlinePrepaymentMethod(p.paymentMethod))
    ) {
      throw orderOnlyModeError();
    }
    if (!allocation) {
      if (dto.paymentId) {
        const max = candidates.reduce((sum, b) => sum + b.refundable, 0);
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.REFUND_EXCEEDS_PAYMENT,
          message: `Über diese Zahlung sind höchstens ${(max / 100).toFixed(2)} € erstattbar.`,
          params: { max: max / 100 },
        });
      }
      throw this.exceeds(held);
    }
    const byId = new Map(payments.map((p) => [p.id, p]));
    const paymentOf = (bucketId: string) =>
      byId.get(bucketId.replace(TOKEN_BUCKET, ''))!;
    const isTokenBucket = (bucketId: string) =>
      bucketId.startsWith(TOKEN_BUCKET);
    if (
      allocation.filter(
        (a) =>
          !isTokenBucket(a.paymentId) &&
          isSumUpTerminal(paymentOf(a.paymentId)),
      ).length > 1
    ) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.REFUND_PAYMENT_REQUIRED,
        message:
          'Der Betrag verteilt sich auf mehrere Kartenzahlungen. Erstatte je Zahlung einzeln.',
      });
    }

    // Zusammensetzung je Zahlung (die letzte nimmt die Rundung auf).
    const parts: Composition[] = [];
    let rest = composition;
    allocation.forEach((a, index) => {
      const part =
        index === allocation.length - 1
          ? rest
          : scaleComposition(composition, a.amount);
      parts.push(part);
      rest = subtractComposition(rest, part);
    });

    const refunds: Refund[] = [];
    let number = priorRefunds.length;
    for (const [index, a] of allocation.entries()) {
      const payment = paymentOf(a.paymentId);
      const tokenBucket = isTokenBucket(a.paymentId);
      const part = parts[index];
      const amount = a.amount / 100;
      // Marken: nichts beim Anbieter, der Gast bekommt die Marken zurueck.
      const { status, providerReference, metadata } = tokenBucket
        ? {
            status: (isTestMode ? 'test' : 'completed') as RefundStatus,
            providerReference: null,
            metadata: {
              tokenLines: returnedTokenLines(
                payment.tokenLines ?? [],
                a.amount,
                cents(payment.tokenAmount),
              ),
            } as Record<string, unknown>,
          }
        : await this.executeProviderRefund(payment, amount, {
            isTestMode,
            manual: dto.manual === true,
            organization,
          });
      number += 1;
      // Trinkgeld an den Verein mindert das Entgelt zum Satz der Ware
      // (spiegelbildlich zum Bon); TrinkgeldAN (Arbeitnehmer) nicht.
      const tipShares =
        part.tip > 0 &&
        vatExempt === false &&
        (await this.tseSigning?.tipRecipientFor(
          payment.processedByWaiterId,
        )) !== 'employee'
          ? tipByRate(part.goods, part.tip, composition.goods)
          : null;
      // Einzweckgutschein: die Steuer entstand beim Verkauf der Marke — die
      // Rueckgabe der damit bezahlten Ware mindert sie nicht.
      const taxLines = refundTaxLines(
        tokenBucket
          ? withoutSinglePurpose(
              part,
              metadata.tokenLines as PaymentTokenLine[],
            )
          : part,
        vatExempt,
        tipShares,
      );
      const refund = manager.create(Refund, {
        organizationId: actor.organizationId,
        orderId: order.id,
        paymentId: payment.id,
        eventId: order.eventId,
        refundNumber: `${order.orderNumber}-E${number}`,
        kind,
        amount: -amount,
        taxTotal: round2(taxLines.reduce((sum, l) => sum + l.tax, 0)),
        pfandAmount: -(pfandSum(part) / 100),
        tipAmount: -(part.tip / 100),
        taxLines,
        paymentMethod: tokenBucket
          ? PaymentMethod.TOKENS
          : payment.paymentMethod,
        status,
        provider: tokenBucket
          ? PaymentProvider.TOKENS
          : payment.paymentProvider,
        providerReference,
        reasonCode: dto.reasonCode,
        reasonText: dto.reasonText?.trim() || null,
        deviceId: actor.deviceId,
        userId: actor.userId,
        waiterId: actor.waiterId ?? null,
        approvedByWaiterId: actor.approvedByWaiterId ?? null,
        approvedByUserId: actor.approvedByUserId ?? null,
        actorName: actor.actorName,
        isTest: order.isTest || isTestMode,
        clientRequestId: index === 0 ? (dto.clientRequestId ?? null) : null,
        metadata: {
          ...metadata,
          composition: compositionToMetadata(part),
          ...(allocation.length > 1
            ? { splitOf: allocation.length, splitIndex: index + 1 }
            : {}),
        },
        items:
          index === 0
            ? this.refundItems(lines, part, manager)
            : ([] as RefundItem[]),
      });
      refunds.push(await manager.save(refund));

      const refundedSoFar = tokenBucket
        ? refundedTokensByPayment
        : refundedByPayment;
      refundedSoFar.set(
        payment.id,
        (refundedSoFar.get(payment.id) ?? 0) + a.amount,
      );
      const remainingOnPayment =
        cents(payment.amount) +
        cents(payment.tokenAmount ?? 0) -
        (refundedByPayment.get(payment.id) ?? 0) -
        (refundedTokensByPayment.get(payment.id) ?? 0);
      if (remainingOnPayment <= 0) {
        payment.status = PaymentTransactionStatus.REFUNDED;
        await manager.save(payment);
      }
    }

    order.refundedAmount = round2(
      Number(order.refundedAmount || 0) + refundCents / 100,
    );
    if (cancelled) this.finishOrderState(order, items, cancelled, reason);
    if (
      cents(order.paidAmount) > 0 &&
      cents(order.refundedAmount) >= cents(order.paidAmount)
    ) {
      order.paymentStatus = PaymentStatus.REFUNDED;
    }
    await manager.save(order);
    await this.recordEvent(manager, actor, order.id, 'refunded', {
      refunds: refunds.map((r) => ({
        id: r.id,
        refundNumber: r.refundNumber,
        amount: Number(r.amount),
        paymentMethod: r.paymentMethod,
        status: r.status,
      })),
      kind,
      mode: dto.mode,
      reasonCode: dto.reasonCode,
      reasonText: dto.reasonText ?? null,
      cancelledItems: cancelled
        ? cancelled.lines.map((l) => ({
            productName: l.item.productName,
            quantity: l.quantity,
            started: l.started,
            restocked: l.restocked,
          }))
        : [],
    });

    return { order, refunds, cancelled, reason };
  }

  private refundItems(
    lines: {
      item: OrderItem;
      quantity: number;
      goods: number;
      deposit: number;
      cancelled: boolean;
    }[],
    part: Composition,
    manager: EntityManager,
  ): RefundItem[] {
    if (!lines.length) return [];
    // Zeilenbetraege an die Zusammensetzung dieses Belegs anpassen
    // (Teilzahlung, mehrere Zahlungen): Summe Ware/Pfand stimmt exakt.
    const goodsTotal = [...part.goods.values()].reduce((s, v) => s + v, 0);
    const goods = distribute(
      lines.map((l) => l.goods || cents(unitGross(l.item)) * l.quantity),
      goodsTotal,
    );
    // Pfand je Satz nur auf die Zeilen mit Pfand dieses Satzes verteilen.
    const deposits = lines.map(() => 0);
    for (const [rate, total] of part.pfand) {
      const weights = lines.map((l) =>
        depositRateOf(l.item) === rate ? l.deposit : 0,
      );
      if (!weights.some((w) => w > 0)) continue;
      distribute(weights, total).forEach((value, index) => {
        deposits[index] += value;
      });
    }
    return lines.map((line, index) =>
      manager.create(RefundItem, {
        orderItemId: line.item.id,
        productName: line.item.productName,
        quantity: line.quantity,
        unitPrice: unitGross(line.item),
        taxRate: Number(line.item.taxRate) || 0,
        amount: -(goods[index] / 100),
        depositAmount: -(deposits[index] / 100),
        depositTaxRate:
          deposits[index] !== 0 && line.item.depositTaxRate != null
            ? depositRateOf(line.item)
            : null,
        cancelled: line.cancelled,
      }),
    );
  }

  private async executeProviderRefund(
    payment: Payment,
    amount: number,
    options: {
      isTestMode: boolean;
      manual: boolean;
      organization: Organization | null;
    },
  ): Promise<{
    status: RefundStatus;
    providerReference: string | null;
    metadata: Record<string, unknown>;
  }> {
    const reference = payment.providerTransactionId ?? null;
    if (payment.paymentMethod === PaymentMethod.CASH) {
      // Bargeldlos: refundInTransaction verteilt gar nicht erst auf
      // Barzahlungen; hier nur zur Sicherheit.
      assertCashAllowed(options.organization, PaymentMethod.CASH);
      return {
        status: options.isTestMode ? 'test' : 'completed',
        providerReference: null,
        metadata: {},
      };
    }
    if (options.isTestMode) {
      return {
        status: 'test',
        providerReference: reference,
        metadata: {
          note: 'Testmodus: beim Zahlungsanbieter nicht erstattet',
        },
      };
    }
    if (options.manual) {
      return {
        status: 'manual',
        providerReference: reference,
        metadata: { note: 'Als manuell erstattet gebucht' },
      };
    }
    if (!isSumUpTerminal(payment)) {
      // Fremdes Kartengeraet, Online, fruehere PayPal-Zahlungen (Anbindung
      // seit 1.8 entfernt): ausserhalb erstatten, hier nur gebucht.
      return {
        status: 'manual',
        providerReference: reference,
        metadata: {
          note: 'Am Kartenterminal bzw. beim Anbieter erstatten',
        },
      };
    }

    const settings = options.organization?.settings;
    const sumup = settings?.sumup;
    if (
      !isIntegrationEnabled(settings, 'sumup') ||
      !sumup?.apiKey ||
      !sumup?.merchantCode ||
      !reference
    ) {
      throw new RefundProviderError(payment.id, amount, {
        errorType: !reference
          ? 'TRANSACTION_ID_MISSING'
          : 'SUMUP_NOT_CONFIGURED',
        message: !reference
          ? 'Zur Zahlung ist keine SumUp-Transaktion gespeichert'
          : 'SumUp ist nicht eingerichtet oder ausgeschaltet',
      });
    }
    try {
      const result = await this.sumUpApiService.refundTransaction(
        sumup.apiKey,
        sumup.merchantCode,
        reference,
        amount,
      );
      return {
        status: 'completed',
        providerReference: result.transactionId,
        metadata: {
          clientTransactionId: reference,
          transactionCode: result.transactionCode,
        },
      };
    } catch (error) {
      const response =
        error instanceof BadRequestException ||
        error instanceof ForbiddenException
          ? error.getResponse()
          : { message: (error as Error).message };
      throw new RefundProviderError(payment.id, amount, response);
    }
  }

  private exceeds(held: number) {
    return new BadRequestException({
      code: ErrorCodes.VALIDATION_ERROR,
      reason: ErrorReasons.REFUND_EXCEEDS_REFUNDABLE,
      message: `Erstattbar sind höchstens ${(held / 100).toFixed(2)} €.`,
      params: { max: held / 100 },
    });
  }

  // ---------------------------------------------------------------------
  // Nachdruck
  // ---------------------------------------------------------------------

  async reprintRefund(
    actor: RefundActor,
    orderId: string,
    refundId: string,
  ): Promise<boolean> {
    const refund = await this.refundRepository.findOne({
      where: { id: refundId, orderId, organizationId: actor.organizationId },
      relations: ['items', 'order', 'device'],
    });
    if (!refund) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.REFUND_NOT_FOUND,
        message: 'Erstattung nicht gefunden',
      });
    }
    const printed = await this.orderPrintService.printRefundReceipt(
      actor.organizationId,
      {
        refund,
        order: refund.order,
        deviceId: actor.deviceId ?? refund.deviceId,
        deviceName: refund.device?.name ?? null,
        reprint: true,
        // Gespeicherter Gegenbeleg (keine neue Transaktion); bisher fehlte
        // der TSE-Block im Nachdruck.
        tse: (await this.tseSigning?.forRefund(refund.id)) ?? null,
      },
    );
    await this.recordEvent(
      this.dataSource.manager,
      actor,
      orderId,
      'refund_receipt_reprinted',
      { refundId, refundNumber: refund.refundNumber, printed },
    );
    return printed;
  }

  /** Nachdruck Kassen-/Kuechenbon protokollieren. */
  async recordReprint(
    actor: RefundActor,
    orderId: string,
    type: 'tickets' | 'receipt',
  ): Promise<void> {
    await this.recordEvent(
      this.dataSource.manager,
      actor,
      orderId,
      type === 'receipt' ? 'receipt_reprinted' : 'tickets_reprinted',
      {},
    );
  }

  detail(organizationId: string, orderId: string): Promise<OrderHistoryDetail> {
    return this.orderHistoryService.detail(organizationId, orderId);
  }

  // ---------------------------------------------------------------------
  // Hilfen
  // ---------------------------------------------------------------------

  private async lockOrder(
    manager: EntityManager,
    organizationId: string,
    orderId: string,
  ) {
    // FOR UPDATE ohne Joins (Postgres sperrt keine Outer-Join-Seite).
    const order = await manager.findOne(Order, {
      where: { id: orderId, organizationId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!order) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.ORDER_NOT_FOUND,
        message: 'Bestellung nicht gefunden',
      });
    }
    const items = await manager.find(OrderItem, {
      where: { orderId: order.id },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    order.items = items;
    const organization = await manager.findOne(Organization, {
      where: { id: organizationId },
      select: OPERATING_MODE_SELECT,
    });
    const event = order.eventId
      ? await manager.findOne(Event, {
          where: { id: order.eventId },
          select: { id: true, status: true },
        })
      : null;
    return {
      order,
      items,
      organization,
      vatExempt: organization?.settings?.vatExempt,
      isTestMode: order.isTest || event?.status === EventStatus.TEST,
    };
  }

  private resolveSelections(
    items: OrderItem[],
    selections: RefundItemSelectionDto[],
  ): { item: OrderItem; quantity: number }[] {
    const merged = new Map<string, number>();
    for (const s of selections) {
      merged.set(s.orderItemId, (merged.get(s.orderItemId) ?? 0) + s.quantity);
    }
    return [...merged.entries()].map(([id, quantity]) => {
      const item = items.find((i) => i.id === id);
      if (!item) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.ORDER_ITEM_NOT_FOUND,
          message: `Artikel nicht gefunden: ${id}`,
        });
      }
      return { item, quantity };
    });
  }

  private planCancellation(
    items: OrderItem[],
    selections: RefundItemSelectionDto[],
    options: { confirmStarted: boolean; hasReason: boolean },
  ): { item: OrderItem; quantity: number; started: boolean }[] {
    const plan = this.resolveSelections(items, selections).map(
      ({ item, quantity }) => {
        if (item.status === OrderItemStatus.CANCELLED) {
          throw new BadRequestException({
            code: ErrorCodes.VALIDATION_ERROR,
            reason: ErrorReasons.ORDER_ITEM_CANCELLED,
            message: `${item.productName} ist bereits storniert.`,
            params: { product: item.productName },
          });
        }
        const open = item.quantity - (item.refundedQuantity || 0);
        if (quantity > open) {
          throw new BadRequestException({
            code: ErrorCodes.VALIDATION_ERROR,
            reason: ErrorReasons.REFUND_QUANTITY_EXCEEDED,
            message: `Von ${item.productName} sind nur ${open} stornierbar.`,
            params: { product: item.productName, max: open },
          });
        }
        return { item, quantity, started: STARTED.has(item.status) };
      },
    );
    const started = plan.filter((p) => p.started);
    if (started.length && !options.confirmStarted) {
      throw new ConflictException({
        code: ErrorCodes.CONFLICT,
        reason: ErrorReasons.ORDER_ITEM_ALREADY_STARTED,
        message:
          'Die Küche hat schon begonnen. Bestätige das Storno ausdrücklich und gib einen Grund an.',
        params: {
          items: started.map((p) => p.item.productName),
          itemIds: started.map((p) => p.item.id),
        },
      });
    }
    if (started.length && !options.hasReason) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.REFUND_REASON_REQUIRED,
        message: 'Gib einen Grund an (z. B. Ausschuss).',
      });
    }
    return plan;
  }

  /**
   * Setzt die Positionen auf „storniert“ (Teilmenge: neue Zeile mit der
   * stornierten Menge), bucht bei noch nicht begonnenen Positionen den
   * Bestand zurueck und rechnet die Summen neu.
   */
  private async applyCancellation(
    manager: EntityManager,
    order: Order,
    items: OrderItem[],
    plan: { item: OrderItem; quantity: number; started: boolean }[],
    actor: RefundActor,
    reason: string | null,
    vatExempt: boolean | undefined,
  ): Promise<CancelResult> {
    const lines: CancelLine[] = [];
    const restocked = new Map<string, Product>();

    for (const { item, quantity, started } of plan) {
      const previousStatus = item.status;
      let cancelledRow: OrderItem;
      if (quantity < item.quantity) {
        const keep = item.quantity - quantity;
        const unit = unitGross(item);
        const paidKeep = Math.min(item.paidQuantity || 0, keep);
        const paidCancelled = Math.max(0, (item.paidQuantity || 0) - paidKeep);
        cancelledRow = manager.create(OrderItem, {
          orderId: item.orderId,
          productId: item.productId,
          categoryId: item.categoryId,
          productName: item.productName,
          categoryName: item.categoryName,
          quantity,
          unitPrice: item.unitPrice,
          optionsPrice: item.optionsPrice,
          taxRate: item.taxRate,
          totalPrice: round2(unit * quantity),
          options: item.options,
          status: OrderItemStatus.CANCELLED,
          notes: item.notes,
          kitchenNotes: item.kitchenNotes,
          paidQuantity: paidCancelled,
          refundedQuantity: 0,
          preparedAt: item.preparedAt,
          readyAt: item.readyAt,
          deliveredAt: item.deliveredAt,
          sortOrder: item.sortOrder,
          productionStationId: item.productionStationId,
          pfandTypeId: item.pfandTypeId,
          depositAmount: item.depositAmount,
          depositTaxRate: item.depositTaxRate,
          isRefill: item.isRefill,
        });
        cancelledRow = await manager.save(cancelledRow);
        items.push(cancelledRow);
        item.quantity = keep;
        item.totalPrice = round2(unit * keep);
        item.paidQuantity = paidKeep;
      } else {
        item.status = OrderItemStatus.CANCELLED;
        cancelledRow = item;
      }

      let didRestock = false;
      if (!started) {
        const product = await manager.findOne(Product, {
          where: { id: item.productId },
        });
        if (product?.trackInventory) {
          const before = product.stockQuantity;
          product.stockQuantity += quantity;
          await manager.save(product);
          restocked.set(product.id, product);
          didRestock = true;
          if (order.eventId) {
            await manager.save(
              manager.create(StockMovement, {
                eventId: order.eventId,
                productId: product.id,
                type: StockMovementType.SALE_CANCELLED,
                quantity,
                quantityBefore: before,
                quantityAfter: product.stockQuantity,
                referenceType: 'order',
                referenceId: order.id,
                reason: reason || 'Storno',
                createdByUserId: actor.userId,
              }),
            );
          }
        }
      }
      lines.push({
        item,
        cancelled: cancelledRow,
        quantity,
        started,
        restocked: didRestock,
        previousStatus,
      });
    }

    await manager.save(items);
    recalcOrderTotals(order, items, vatExempt);
    const orderCancelled = items.every(
      (i) => i.status === OrderItemStatus.CANCELLED,
    );
    return {
      lines,
      restockedProducts: [...restocked.values()],
      orderCancelled,
    };
  }

  /** Status und Zahlstatus nach einem Storno nachziehen. */
  private finishOrderState(
    order: Order,
    items: OrderItem[],
    cancelled: CancelResult,
    reason: string | null,
    forceCancelled = false,
  ) {
    if (cancelled.orderCancelled || forceCancelled) {
      order.status = OrderStatus.CANCELLED;
      order.cancelledAt = new Date();
      order.cancellationReason = reason?.slice(0, 255) ?? null;
      return;
    }
    const paid = cents(order.paidAmount);
    const total = cents(order.total);
    if (order.paymentStatus !== PaymentStatus.REFUNDED) {
      order.paymentStatus =
        paid >= total
          ? PaymentStatus.PAID
          : paid > 0
            ? PaymentStatus.PARTLY_PAID
            : PaymentStatus.UNPAID;
    }
    if (order.status === OrderStatus.COMPLETED) return;
    const active = items.filter((i) => i.status !== OrderItemStatus.CANCELLED);
    const workflowDone = active.every(
      (i) => !i.productionStationId || i.status === OrderItemStatus.DELIVERED,
    );
    // „Ohne Zahlung abgeschlossen“ zaehlt wie bezahlt.
    if (
      (order.paymentStatus === PaymentStatus.PAID ||
        !!order.closedWithoutPaymentAt) &&
      workflowDone
    ) {
      order.status = OrderStatus.COMPLETED;
      order.completedAt = order.completedAt ?? new Date();
    } else if (
      active.every(
        (i) =>
          i.status === OrderItemStatus.READY ||
          i.status === OrderItemStatus.DELIVERED,
      )
    ) {
      order.status = OrderStatus.READY;
      order.readyAt = order.readyAt ?? new Date();
    } else if (active.some((i) => i.status !== OrderItemStatus.PENDING)) {
      order.status = OrderStatus.IN_PROGRESS;
    }
  }

  private async recordEvent(
    manager: EntityManager,
    actor: RefundActor,
    orderId: string,
    type: OrderEventType,
    data: Record<string, unknown>,
  ) {
    await manager.save(
      manager.create(OrderEvent, {
        organizationId: actor.organizationId,
        orderId,
        type,
        deviceId: actor.deviceId,
        userId: actor.userId,
        waiterId: actor.waiterId ?? null,
        actorName: actor.actorName,
        data: {
          ...data,
          deviceName: actor.deviceName,
          ...(actor.approvedByWaiterId || actor.approvedByUserId
            ? {
                approvedByWaiterId: actor.approvedByWaiterId ?? null,
                approvedByUserId: actor.approvedByUserId ?? null,
              }
            : {}),
        },
      }),
    );
  }

  private async recordFailure(
    actor: RefundActor,
    orderId: string,
    error: RefundProviderError,
    dto: CreateRefundDto,
  ) {
    try {
      const response = error.response as {
        message?: string;
        errorType?: string;
      };
      await this.recordEvent(
        this.dataSource.manager,
        actor,
        orderId,
        'refund_failed',
        {
          paymentId: error.paymentId,
          amount: error.amount,
          mode: dto.mode,
          providerError: response?.errorType ?? null,
          providerMessage: response?.message ?? null,
        },
      );
    } catch (e) {
      this.logger.warn(`Could not record refund failure: ${String(e)}`);
    }
  }

  /** Echtzeit fuer Kassen, Stationen und Verwaltung (nach dem Commit). */
  private notifyOrder(organizationId: string, order: Order) {
    this.gatewayService.notifyOrderUpdated(
      organizationId,
      order.eventId,
      order.id,
      {
        status: order.status,
        paymentStatus: order.paymentStatus,
        total: order.total,
        subtotal: order.subtotal,
        taxTotal: order.taxTotal,
        pfandTotal: order.pfandTotal,
        discountAmount: order.discountAmount,
        refundedAmount: order.refundedAmount,
        cancelledAt: order.cancelledAt,
      },
    );
  }

  private afterCancellation(
    actor: RefundActor,
    order: Order,
    cancelled: CancelResult,
    reason: string | null,
  ) {
    for (const line of cancelled.lines) {
      // Die Station laedt bei diesem Ereignis neu und laesst die
      // stornierte Position weg.
      this.gatewayService.notifyOrderItemStatusChanged(
        actor.organizationId,
        order.eventId,
        {
          orderId: order.id,
          orderNumber: order.orderNumber,
          itemId: line.cancelled.id,
          productName: line.item.productName,
          status: OrderItemStatus.CANCELLED,
          previousStatus: line.previousStatus,
        },
      );
    }
    if (cancelled.orderCancelled) {
      this.gatewayService.notifyKitchenOrderCancelled(
        actor.organizationId,
        order.id,
        order.orderNumber,
      );
    }
    if (order.eventId) {
      for (const product of cancelled.restockedProducts) {
        this.gatewayService.notifyProductUpdated(
          actor.organizationId,
          order.eventId,
          {
            id: product.id,
            name: product.name,
            categoryId: product.categoryId,
            price: Number(product.price),
            isAvailable: product.isAvailable,
            isActive: product.isActive,
            stockQuantity: product.stockQuantity,
            trackInventory: product.trackInventory,
          },
        );
      }
    }
    // Cloud-TSE: war die Bestellung als Bestellvorgang abgesichert
    // (Tischbetrieb), wird der Storno als Bestellung-V1 mit negativen
    // Mengen signiert. Nicht blockierend.
    void this.tseSigning?.signOrderChange(
      order.id,
      cancelled.lines.map((l) => ({ item: l.item, quantity: -l.quantity })),
      {
        terminal: actor.deviceId,
        userId: actor.userId,
        waiterId: actor.waiterId ?? null,
        operatorName: actor.actorName,
      },
    );
    // Storno-Bon nur fuer Positionen, die schon in der Kueche lagen.
    const kitchenLines = cancelled.lines.filter(
      (l) => l.previousStatus !== OrderItemStatus.DELIVERED,
    );
    void this.orderPrintService.printCancellationTickets(actor.organizationId, {
      order,
      items: kitchenLines.map((l) => ({
        item: l.cancelled,
        quantity: l.quantity,
      })),
      reason,
    });
  }

  private async afterRefund(actor: RefundActor, outcome: RefundOutcome) {
    const cash = outcome.refunds.some(
      (r) => r.paymentMethod === PaymentMethod.CASH,
    );
    if (cash && actor.cashDrawerPrinterId) {
      try {
        this.gatewayService.sendOpenCashDrawer(
          actor.organizationId,
          actor.cashDrawerPrinterId,
        );
      } catch (e) {
        this.logger.warn(`Failed to open cash drawer: ${String(e)}`);
      }
    }
    // Cloud-TSE: je Erstattung ein Gegenbeleg (Kassenbeleg mit negativen
    // Betraegen, Verweis auf den Ursprungsbeleg) — vor dem Druck.
    const signed = await Promise.all(
      outcome.refunds.map(
        (refund) =>
          this.tseSigning?.signRefund(refund) ?? Promise.resolve(null),
      ),
    );
    for (const [index, refund] of outcome.refunds.entries()) {
      const tse = signed[index];
      (refund as RefundWithTse).tse = tse;
      const printed = await this.orderPrintService.printRefundReceipt(
        actor.organizationId,
        {
          refund,
          order: outcome.order,
          deviceId: actor.deviceId,
          deviceName: actor.deviceName,
          tse,
        },
      );
      (refund as Refund & { printed?: boolean }).printed = printed;
    }
  }
}

/** Erstattung mit TSE-Daten ihres Gegenbelegs (null ohne aktive TSE). */
export type RefundWithTse = Refund & { tse?: TseReceiptView | null };

function isSumUpTerminal(payment: Payment): boolean {
  return (
    payment.paymentProvider === PaymentProvider.SUMUP &&
    payment.paymentMethod === PaymentMethod.SUMUP_TERMINAL
  );
}

function compositionToMetadata(c: Composition) {
  return {
    goods: rateRecord(c.goods),
    // `pfand` (gesamt) bleibt fuer Auswertungen von vor 2026-11 lesbar.
    pfand: pfandSum(c),
    pfandByRate: rateRecord(c.pfand),
    tip: c.tip,
  };
}

function compositionFromMetadata(
  metadata: Record<string, unknown> | null,
): Composition {
  const raw = (metadata?.composition ?? {}) as {
    goods?: Record<string, number>;
    pfand?: number;
    pfandByRate?: Record<string, number>;
    tip?: number;
  };
  return {
    goods: rateMapFrom(raw.goods),
    pfand: pfandFromRecord(raw),
    tip: Number(raw.tip) || 0,
  };
}

/** Verteilt `total` (Cent) im Verhaeltnis der Gewichte, Summe exakt. */
function distribute(weights: number[], total: number): number[] {
  const sum = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  let assigned = 0;
  return weights.map((w, index) => {
    if (index === weights.length - 1) return total - assigned;
    const share = Math.round((total * Math.max(0, w)) / sum);
    assigned += share;
    return share;
  });
}

/** Kennung des Wertmarken-Anteils einer Zahlung bei der Verteilung. */
const TOKEN_BUCKET = 'tokens:';

/**
 * Welche Marken gehen bei einer Erstattung von `refundCents` aus dem
 * Markenanteil einer Zahlung zurueck? Anteilig nach den Markentypen der
 * Zahlung (Wert exakt, Stueckzahl anteilig).
 */
export function returnedTokenLines(
  lines: PaymentTokenLine[],
  refundCents: number,
  tokenCents: number,
): PaymentTokenLine[] {
  const usable = lines.filter((l) => cents(l.amount) > 0);
  if (usable.length === 0 || refundCents <= 0) return [];
  const total = tokenCents || usable.reduce((s, l) => s + cents(l.amount), 0);
  let assigned = 0;
  return usable.map((line, index) => {
    const value =
      index === usable.length - 1
        ? refundCents - assigned
        : Math.round((refundCents * cents(line.amount)) / total);
    assigned += value;
    const unit = cents(line.unitValue);
    return {
      ...line,
      amount: value / 100,
      count: unit > 0 ? Math.round((value / unit) * 1000) / 1000 : 0,
    };
  });
}

/**
 * Zusammensetzung ohne den Teil, den Einzweckgutscheine bezahlt haben (je
 * Satz): darauf wurde die Steuer schon beim Verkauf der Marke erhoben.
 */
function withoutSinglePurpose(
  part: Composition,
  lines: PaymentTokenLine[] | undefined,
): Composition {
  const goods = new Map(part.goods);
  for (const line of lines ?? []) {
    if (line.kind !== 'single_purpose' || line.vatRate === null) continue;
    const rate = Number(line.vatRate);
    goods.set(rate, Math.max(0, (goods.get(rate) ?? 0) - cents(line.amount)));
  }
  return { ...part, goods };
}
