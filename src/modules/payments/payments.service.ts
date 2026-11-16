import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Payment,
  Order,
  OrderItem,
  OrderItemPayment,
  Organization,
  User,
  UserOrganization,
} from '../../database/entities';
import {
  PaymentMethod,
  PaymentProvider,
  PaymentTransactionStatus,
} from '../../database/entities/payment.entity';
import { PaymentStatus } from '../../database/entities/order.entity';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  PaginatedResult,
  createPaginatedResult,
} from '../../common/dto/pagination.dto';
import { CreatePaymentDto, SplitPaymentDto, QueryPaymentsDto } from './dto';
import { OrderPrintService } from '../print-jobs/order-print.service';
import { cashReceivedMetadata } from '../print-jobs/receipt-tax.util';
import {
  assertCashAllowed,
  isCashlessPaymentMethod,
  OPERATING_MODE_SELECT,
} from '../../common/utils/operating-mode.util';
import { closedWithoutPaymentError } from '../orders/close-without-payment';
import { assertMayManageOrders } from '../orders/order-permissions';
import { planSplitPayment } from './split-payment';
import { assertPaymentsAllowed } from '../../common/utils/operating-mode.util';
import { assertIntegrationEnabled } from '../integrations/integration-catalog';
import { TseSigningService } from '../tse/tse-signing.service';
import { endOfDay, startOfDay } from '../../common/utils/date-range.util';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(OrderItem)
    private readonly orderItemRepository: Repository<OrderItem>,
    @InjectRepository(OrderItemPayment)
    private readonly orderItemPaymentRepository: Repository<OrderItemPayment>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    private readonly orderPrintService: OrderPrintService,
    @Optional()
    private readonly tseSigning?: TseSigningService,
  ) {}

  async create(
    organizationId: string,
    createDto: CreatePaymentDto,
    user: User,
  ): Promise<Payment> {
    // Zahlungen in der Verwaltung erfassen (ohne Kasse) nur mit dem Recht
    // „Bestellungen“ oder als Admin; an der Kasse kassiert das Geraet.
    assertMayManageOrders(
      user,
      await this.checkMembership(organizationId, user.id),
    );
    await this.assertPaymentsAllowedFor(organizationId);

    const order = await this.orderRepository.findOne({
      where: { id: createDto.orderId, organizationId },
      relations: ['items'],
    });

    if (!order) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.ORDER_NOT_FOUND,
        message: 'Bestellung nicht gefunden',
      });
    }

    if (order.paymentStatus === PaymentStatus.PAID) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.ORDER_ALREADY_PAID,
        message: 'Bestellung ist bereits vollständig bezahlt',
      });
    }
    if (order.closedWithoutPaymentAt) {
      throw closedWithoutPaymentError([order.id]);
    }

    const remainingAmount = Number(order.total) - Number(order.paidAmount);
    if (createDto.amount > remainingAmount) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.PAYMENT_EXCEEDS_REMAINING,
        message: `Zahlungsbetrag (${createDto.amount}) übersteigt den ausstehenden Betrag (${remainingAmount})`,
        params: { amount: createDto.amount, remaining: remainingAmount },
      });
    }

    const provider = this.getProviderForMethod(createDto.paymentMethod);
    await this.assertPaymentMethodAllowed(
      organizationId,
      createDto.paymentMethod,
    );

    const payment = this.paymentRepository.create({
      orderId: createDto.orderId,
      amount: createDto.amount,
      paymentMethod: createDto.paymentMethod,
      paymentProvider: provider,
      providerTransactionId: createDto.providerTransactionId || null,
      status: PaymentTransactionStatus.CAPTURED,
      metadata: {
        ...(createDto.metadata || {}),
        ...cashReceivedMetadata(
          createDto.paymentMethod,
          createDto.amount,
          createDto.amountReceived,
        ),
      },
      processedByUserId: user.id,
    });

    await this.paymentRepository.save(payment);

    // Update order paid amount
    order.paidAmount = Number(order.paidAmount) + createDto.amount;
    await this.updateOrderPaymentStatus(order);

    // For full payment, mark all items as paid
    const isFullyPaid = Number(order.paidAmount) >= Number(order.total);
    if (isFullyPaid) {
      for (const item of order.items) {
        item.paidQuantity = item.quantity;
        await this.orderItemRepository.save(item);
      }
    }

    this.logger.log(
      `Payment created: ${payment.id} for order ${order.orderNumber}`,
    );

    // Cloud-TSE: Kassenbeleg vor dem Bon signieren (wirft nie).
    const tse = (await this.tseSigning?.signPayment(payment.id)) ?? null;

    // Trigger auto-printing for payment
    this.orderPrintService
      .handlePaymentReceived(organizationId, {
        orderId: order.id,
        orderNumber: order.orderNumber,
        paymentId: payment.id,
        amount: Number(payment.amount),
        paymentMethod: payment.paymentMethod,
        isFullyPaid: isFullyPaid,
        order,
        amountReceived: payment.metadata?.amountReceived,
        tse,
      })
      .catch((err: Error) => {
        this.logger.error(`Failed to trigger payment printing: ${err.message}`);
      });

    const created = await this.findOne(organizationId, payment.id, user);
    return Object.assign(created, { tse });
  }

  async createSplitPayment(
    organizationId: string,
    splitDto: SplitPaymentDto,
    user: User,
  ): Promise<Payment> {
    // Zahlungen in der Verwaltung erfassen (ohne Kasse) nur mit dem Recht
    // „Bestellungen“ oder als Admin; an der Kasse kassiert das Geraet.
    assertMayManageOrders(
      user,
      await this.checkMembership(organizationId, user.id),
    );
    await this.assertPaymentsAllowedFor(organizationId);

    const provider = this.getProviderForMethod(splitDto.paymentMethod);
    await this.assertPaymentMethodAllowed(
      organizationId,
      splitDto.paymentMethod,
    );

    /* Pruefen und Buchen in einer Transaktion mit gesperrter Bestellung,
       damit gleichzeitige Zahlungen dieselben Positionen nicht doppelt
       kassieren. */
    const { order, payment } = await this.orderRepository.manager.transaction(
      async (manager) => {
        const orders = manager.getRepository(Order);
        const row = await orders.findOne({
          where: { id: splitDto.orderId, organizationId },
          lock: { mode: 'pessimistic_write' },
        });
        const current = row
          ? await orders.findOne({
              where: { id: row.id, organizationId },
              relations: ['items'],
            })
          : null;
        if (!current) {
          throw new NotFoundException({
            code: ErrorCodes.NOT_FOUND,
            reason: ErrorReasons.ORDER_NOT_FOUND,
            message: 'Bestellung nicht gefunden',
          });
        }
        if (current.closedWithoutPaymentAt) {
          throw closedWithoutPaymentError([current.id]);
        }

        // Positionen pruefen, Betrag berechnen; nie mehr als offen ist.
        const plan = planSplitPayment(current, splitDto.items, splitDto.amount);

        const payments = manager.getRepository(Payment);
        const created = payments.create({
          orderId: current.id,
          amount: plan.amount,
          paymentMethod: splitDto.paymentMethod,
          paymentProvider: provider,
          providerTransactionId: splitDto.providerTransactionId || null,
          status: PaymentTransactionStatus.CAPTURED,
          metadata: {
            ...(splitDto.metadata || {}),
            ...cashReceivedMetadata(
              splitDto.paymentMethod,
              plan.amount,
              splitDto.amountReceived,
            ),
          },
          processedByUserId: user.id,
        });
        await payments.save(created);

        // Zuordnung je Position und bezahlte Mengen
        const itemPayments = manager.getRepository(OrderItemPayment);
        const items = manager.getRepository(OrderItem);
        for (const { item, quantity, amount } of plan.lines) {
          await itemPayments.save(
            itemPayments.create({
              paymentId: created.id,
              orderItemId: item.id,
              quantity,
              amount,
            }),
          );
          item.paidQuantity = (item.paidQuantity || 0) + quantity;
          await items.save(item);
        }

        current.paidAmount = Number(current.paidAmount) + plan.amount;
        setPaymentStatus(current);
        await orders.save(current);
        return { order: current, payment: created };
      },
    );

    this.logger.log(
      `Split payment created: ${payment.id} for order ${order.orderNumber}`,
    );

    // Cloud-TSE: Kassenbeleg der Teilzahlung (zugeordnete Positionen).
    const tse = (await this.tseSigning?.signPayment(payment.id)) ?? null;

    // Trigger auto-printing for payment
    const isFullyPaid = Number(order.paidAmount) >= Number(order.total);
    this.orderPrintService
      .handlePaymentReceived(organizationId, {
        orderId: order.id,
        orderNumber: order.orderNumber,
        paymentId: payment.id,
        amount: Number(payment.amount),
        paymentMethod: payment.paymentMethod,
        isFullyPaid,
        order,
        amountReceived: payment.metadata?.amountReceived,
        tse,
      })
      .catch((err: Error) => {
        this.logger.error(`Failed to trigger payment printing: ${err.message}`);
      });

    const created = await this.findOne(organizationId, payment.id, user);
    return Object.assign(created, { tse });
  }

  async findAll(
    organizationId: string,
    user: User,
    query: QueryPaymentsDto,
  ): Promise<PaginatedResult<Payment>> {
    await this.checkMembership(organizationId, user.id);

    const { page = 1, limit = 50 } = query;
    const skip = (page - 1) * limit;

    const queryBuilder = this.paymentRepository
      .createQueryBuilder('payment')
      .innerJoin('payment.order', 'order')
      .where('order.organizationId = :organizationId', { organizationId });

    if (query.orderId) {
      queryBuilder.andWhere('payment.orderId = :orderId', {
        orderId: query.orderId,
      });
    }

    if (query.paymentMethod) {
      queryBuilder.andWhere('payment.paymentMethod = :paymentMethod', {
        paymentMethod: query.paymentMethod,
      });
    }

    if (query.status) {
      queryBuilder.andWhere('payment.status = :status', {
        status: query.status,
      });
    }

    if (query.dateFrom) {
      queryBuilder.andWhere('payment.createdAt >= :dateFrom', {
        dateFrom: startOfDay(query.dateFrom),
      });
    }

    if (query.dateTo) {
      queryBuilder.andWhere('payment.createdAt <= :dateTo', {
        dateTo: endOfDay(query.dateTo),
      });
    }

    queryBuilder.orderBy('payment.createdAt', 'DESC').skip(skip).take(limit);

    const [items, total] = await queryBuilder.getManyAndCount();

    return createPaginatedResult(items, total, page, limit);
  }

  async findOne(
    organizationId: string,
    paymentId: string,
    user: User,
  ): Promise<Payment> {
    await this.checkMembership(organizationId, user.id);

    const payment = await this.paymentRepository.findOne({
      where: { id: paymentId },
      relations: [
        'order',
        'itemPayments',
        'itemPayments.orderItem',
        'processedByUser',
      ],
    });

    if (!payment || payment.order.organizationId !== organizationId) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.PAYMENT_NOT_FOUND,
        message: 'Zahlung nicht gefunden',
      });
    }

    return payment;
  }

  async getPaymentsByOrder(
    organizationId: string,
    orderId: string,
    user: User,
  ): Promise<Payment[]> {
    await this.checkMembership(organizationId, user.id);

    // Verify order belongs to organization
    const order = await this.orderRepository.findOne({
      where: { id: orderId, organizationId },
    });

    if (!order) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.ORDER_NOT_FOUND,
        message: 'Bestellung nicht gefunden',
      });
    }

    return this.paymentRepository.find({
      where: { orderId },
      relations: ['itemPayments', 'itemPayments.orderItem', 'processedByUser'],
      order: { createdAt: 'DESC' },
    });
  }

  // Private helper methods

  /**
   * Darf die Organisation mit dieser Zahlart buchen? SumUp nur bei
   * eingeschaltetem SumUp (`card` ist ein fremdes Kartengeraet ohne
   * Anbindung und bleibt immer moeglich), Bargeld nicht im bargeldlosen
   * Modus.
   */
  /** „Nur Bons“: keine Zahlung, auch nicht aus der Verwaltung. */
  private async assertPaymentsAllowedFor(
    organizationId: string,
  ): Promise<void> {
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: OPERATING_MODE_SELECT,
    });
    assertPaymentsAllowed(organization);
  }

  private async assertPaymentMethodAllowed(
    organizationId: string,
    method: PaymentMethod,
  ): Promise<void> {
    const sumup = this.getProviderForMethod(method) === PaymentProvider.SUMUP;
    // Bargeld und alles ausserhalb der Positivliste fuer „Bargeldlos“
    // (kuenftige Wertmarken o. Ae.) prueft assertCashAllowed.
    const cashLike = !isCashlessPaymentMethod(method);
    if (!sumup && !cashLike) return;
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: OPERATING_MODE_SELECT,
    });
    if (sumup) assertIntegrationEnabled(organization?.settings, 'sumup');
    assertCashAllowed(organization, method);
  }

  private getProviderForMethod(method: PaymentMethod): PaymentProvider {
    switch (method) {
      case PaymentMethod.CASH:
        return PaymentProvider.CASH;
      case PaymentMethod.CARD:
        return PaymentProvider.CARD;
      case PaymentMethod.SUMUP_TERMINAL:
      case PaymentMethod.SUMUP_ONLINE:
        return PaymentProvider.SUMUP;
      default:
        return PaymentProvider.CASH;
    }
  }

  private async updateOrderPaymentStatus(order: Order): Promise<void> {
    setPaymentStatus(order);
    await this.orderRepository.save(order);
  }

  private async checkMembership(
    organizationId: string,
    userId: string,
  ): Promise<UserOrganization> {
    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId },
    });

    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.ORGANIZATION_ACCESS_DENIED,
        message: 'Kein Zugriff auf diese Organisation',
      });
    }
    return membership;
  }
}

/** Zahlungsstatus aus bezahltem Betrag und Summe, in ganzen Cent. */
function setPaymentStatus(order: Order): void {
  const paidCents = Math.round(Number(order.paidAmount) * 100);
  const totalCents = Math.round(Number(order.total) * 100);
  if (paidCents >= totalCents) {
    order.paymentStatus = PaymentStatus.PAID;
  } else if (paidCents > 0) {
    order.paymentStatus = PaymentStatus.PARTLY_PAID;
  } else {
    order.paymentStatus = PaymentStatus.UNPAID;
  }
}
