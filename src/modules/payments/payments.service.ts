import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
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
import { assertIntegrationEnabled } from '../integrations/integration-catalog';
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
  ) {}

  async create(
    organizationId: string,
    createDto: CreatePaymentDto,
    user: User,
  ): Promise<Payment> {
    await this.checkMembership(organizationId, user.id);

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
    await this.assertProviderEnabled(organizationId, provider);

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
      })
      .catch((err: Error) => {
        this.logger.error(`Failed to trigger payment printing: ${err.message}`);
      });

    return this.findOne(organizationId, payment.id, user);
  }

  async createSplitPayment(
    organizationId: string,
    splitDto: SplitPaymentDto,
    user: User,
  ): Promise<Payment> {
    await this.checkMembership(organizationId, user.id);

    const order = await this.orderRepository.findOne({
      where: { id: splitDto.orderId, organizationId },
      relations: ['items'],
    });

    if (!order) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.ORDER_NOT_FOUND,
        message: 'Bestellung nicht gefunden',
      });
    }

    // Validate items and calculate total
    let calculatedTotal = 0;
    const itemsToUpdate: { item: OrderItem; quantityToPayNow: number }[] = [];

    for (const splitItem of splitDto.items) {
      const orderItem = order.items.find((i) => i.id === splitItem.orderItemId);

      if (!orderItem) {
        throw new NotFoundException({
          code: ErrorCodes.NOT_FOUND,
          reason: ErrorReasons.ORDER_ITEM_NOT_FOUND,
          message: `Bestellposition ${splitItem.orderItemId} nicht gefunden`,
        });
      }

      const unpaidQuantity = orderItem.quantity - orderItem.paidQuantity;
      if (splitItem.quantity > unpaidQuantity) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.INSUFFICIENT_UNPAID_QUANTITY,
          message: `Nicht genügend unbezahlte Menge für ${orderItem.productName} (${unpaidQuantity} verfügbar)`,
          params: { product: orderItem.productName },
        });
      }

      const pricePerUnit =
        Number(orderItem.unitPrice) + Number(orderItem.optionsPrice);
      calculatedTotal += pricePerUnit * splitItem.quantity;

      itemsToUpdate.push({
        item: orderItem,
        quantityToPayNow: splitItem.quantity,
      });
    }

    // Allow some tolerance for rounding
    const tolerance = 0.02;
    if (Math.abs(calculatedTotal - splitDto.amount) > tolerance) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.PAYMENT_AMOUNT_MISMATCH,
        message: `Berechneter Betrag (${calculatedTotal.toFixed(2)}) stimmt nicht mit dem Zahlungsbetrag (${splitDto.amount}) überein`,
        params: {
          expected: calculatedTotal.toFixed(2),
          received: splitDto.amount,
        },
      });
    }

    const provider = this.getProviderForMethod(splitDto.paymentMethod);
    await this.assertProviderEnabled(organizationId, provider);

    const payment = this.paymentRepository.create({
      orderId: splitDto.orderId,
      amount: splitDto.amount,
      paymentMethod: splitDto.paymentMethod,
      paymentProvider: provider,
      providerTransactionId: splitDto.providerTransactionId || null,
      status: PaymentTransactionStatus.CAPTURED,
      metadata: {
        ...(splitDto.metadata || {}),
        ...cashReceivedMetadata(
          splitDto.paymentMethod,
          splitDto.amount,
          splitDto.amountReceived,
        ),
      },
      processedByUserId: user.id,
    });

    await this.paymentRepository.save(payment);

    // Create order item payments and update paid quantities
    for (const { item, quantityToPayNow } of itemsToUpdate) {
      const pricePerUnit = Number(item.unitPrice) + Number(item.optionsPrice);

      const itemPayment = this.orderItemPaymentRepository.create({
        paymentId: payment.id,
        orderItemId: item.id,
        quantity: quantityToPayNow,
        amount: pricePerUnit * quantityToPayNow,
      });

      await this.orderItemPaymentRepository.save(itemPayment);

      item.paidQuantity += quantityToPayNow;
      await this.orderItemRepository.save(item);
    }

    // Update order paid amount
    order.paidAmount = Number(order.paidAmount) + splitDto.amount;
    await this.updateOrderPaymentStatus(order);

    this.logger.log(
      `Split payment created: ${payment.id} for order ${order.orderNumber}`,
    );

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
      })
      .catch((err: Error) => {
        this.logger.error(`Failed to trigger payment printing: ${err.message}`);
      });

    return this.findOne(organizationId, payment.id, user);
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
   * SumUp-Zahlungen nur bei eingeschaltetem SumUp verbuchen. `card` ist ein
   * fremdes Kartengeraet ohne Anbindung und bleibt wie Bargeld immer
   * moeglich — gesperrt wird nur, was ueber SumUp laeuft.
   */
  private async assertProviderEnabled(
    organizationId: string,
    provider: PaymentProvider,
  ): Promise<void> {
    if (provider !== PaymentProvider.SUMUP) return;
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: { id: true, settings: true },
    });
    assertIntegrationEnabled(organization?.settings, 'sumup');
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
    const total = Number(order.total);
    const paidAmount = Number(order.paidAmount);

    if (paidAmount >= total) {
      order.paymentStatus = PaymentStatus.PAID;
    } else if (paidAmount > 0) {
      order.paymentStatus = PaymentStatus.PARTLY_PAID;
    } else {
      order.paymentStatus = PaymentStatus.UNPAID;
    }

    await this.orderRepository.save(order);
  }

  private async checkMembership(
    organizationId: string,
    userId: string,
  ): Promise<void> {
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
  }
}
