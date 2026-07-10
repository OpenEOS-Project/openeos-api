import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import {
  Repository,
  Between,
  LessThanOrEqual,
  MoreThanOrEqual,
  SelectQueryBuilder,
} from 'typeorm';
import {
  Order,
  OrderItem,
  Product,
  User,
  UserOrganization,
  StockMovement,
  Event,
  ProductionStation,
  Organization,
} from '../../database/entities';
import { isPfandChargedForFulfillment } from '../../common/utils/pfand-policy';
import {
  OrderStatus,
  PaymentStatus,
  OrderSource,
  OrderFulfillmentType,
} from '../../database/entities/order.entity';
import { OrderItemStatus } from '../../database/entities/order-item.entity';
import { StockMovementType } from '../../database/entities/stock-movement.entity';
import { EventStatus } from '../../database/entities/event.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import { assertTestEventOrderLimitNotReached } from '../../common/utils/test-event-order-limit.util';
import {
  PaginatedResult,
  createPaginatedResult,
} from '../../common/dto/pagination.dto';
import {
  CreateOrderDto,
  UpdateOrderDto,
  AddOrderItemDto,
  UpdateOrderItemDto,
  QueryOrdersDto,
  CancelOrderDto,
} from './dto';
import { OrderPrintService } from '../print-jobs/order-print.service';
import { PrintJobsService } from '../print-jobs/print-jobs.service';
import { GatewayService } from '../gateway/gateway.service';

export interface OrderStats {
  count: number;
  revenue: number;
  avgReceipt: number;
  pfand: number;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(OrderItem)
    private readonly orderItemRepository: Repository<OrderItem>,
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    @InjectRepository(StockMovement)
    private readonly stockMovementRepository: Repository<StockMovement>,
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    @InjectRepository(ProductionStation)
    private readonly productionStationRepository: Repository<ProductionStation>,
    private readonly orderPrintService: OrderPrintService,
    private readonly printJobsService: PrintJobsService,
    @Inject(forwardRef(() => GatewayService))
    private readonly gatewayService: GatewayService,
    private readonly configService: ConfigService,
  ) {}

  async create(
    organizationId: string,
    createDto: CreateOrderDto,
    user: User,
  ): Promise<Order> {
    await this.checkMembership(organizationId, user.id);

    // Validate event if provided
    if (createDto.eventId) {
      const event = await this.eventRepository.findOne({
        where: { id: createDto.eventId, organizationId },
      });

      if (!event) {
        throw new NotFoundException({
          code: ErrorCodes.NOT_FOUND,
          message: 'Event nicht gefunden',
        });
      }

      if (
        event.status !== EventStatus.ACTIVE &&
        event.status !== EventStatus.TEST
      ) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Event ist nicht aktiv',
        });
      }

      if (event.status === EventStatus.TEST) {
        const existingOrderCount = await this.orderRepository.count({
          where: { eventId: event.id },
        });
        assertTestEventOrderLimitNotReached(
          event.status,
          existingOrderCount,
          this.configService.get<number>('billing.testEventMaxOrders', 25),
        );
      }
    }

    // Generate order number
    const orderNumber = await this.generateOrderNumber(organizationId);
    const dailyNumber = await this.getDailyNumber(
      organizationId,
      createDto.eventId || null,
    );

    const order = this.orderRepository.create({
      organizationId,
      eventId: createDto.eventId || null,
      orderNumber,
      dailyNumber,
      tableNumber: createDto.tableNumber || null,
      customerName: createDto.customerName || null,
      customerPhone: createDto.customerPhone || null,
      notes: createDto.notes || null,
      priority: createDto.priority || undefined,
      source: createDto.source || OrderSource.POS,
      fulfillmentType:
        createDto.fulfillmentType || OrderFulfillmentType.COUNTER_PICKUP,
      discountAmount: createDto.discountAmount || 0,
      discountReason: createDto.discountReason || null,
      createdByUserId: user.id,
      status: OrderStatus.OPEN,
      paymentStatus: PaymentStatus.UNPAID,
    });

    await this.orderRepository.save(order);

    // Add items if provided
    if (createDto.items && createDto.items.length > 0) {
      const chargePfand = await this.shouldChargePfand(order);
      for (const itemDto of createDto.items) {
        await this.addItemToOrder(order, itemDto, user, chargePfand);
      }

      // Recalculate totals
      await this.recalculateOrderTotals(order.id);
    }

    this.logger.log(`Order created: ${order.orderNumber} (${order.id})`);

    // Trigger auto-printing asynchronously
    const createdOrder = await this.findOne(organizationId, order.id, user);
    this.orderPrintService
      .handleOrderCreated(organizationId, {
        order: createdOrder,
        orderId: createdOrder.id,
        orderNumber: createdOrder.orderNumber,
        tableNumber: createdOrder.tableNumber,
        total: createdOrder.total,
        source: createdOrder.source,
      })
      .catch((error) => {
        this.logger.error(
          `Failed to trigger auto-printing for order ${order.id}: ${error.message}`,
        );
      });

    // Print station tickets for new order items
    if (createdOrder.items && createdOrder.items.length > 0) {
      const itemsByStation = new Map<
        string | null,
        typeof createdOrder.items
      >();
      for (const item of createdOrder.items) {
        const key = item.productionStationId || null;
        if (!itemsByStation.has(key)) itemsByStation.set(key, []);
        itemsByStation.get(key)!.push(item);
      }

      for (const [stationId, items] of itemsByStation) {
        if (stationId) {
          const station = await this.productionStationRepository.findOne({
            where: { id: stationId },
          });
          if (station && station.printerId) {
            this.printToStation(organizationId, station, createdOrder, items);
          }
        }
      }
    }

    return createdOrder;
  }

  async findAll(
    organizationId: string,
    user: User,
    query: QueryOrdersDto,
  ): Promise<PaginatedResult<Order>> {
    await this.checkMembership(organizationId, user.id);

    const { page = 1, limit = 50 } = query;
    const skip = (page - 1) * limit;

    const queryBuilder = this.orderRepository
      .createQueryBuilder('ord')
      .where('ord.organizationId = :organizationId', { organizationId });

    // Surface "who created it" without leaking sensitive user columns
    // (the User entity has no @Exclude on passwordHash, so never use
    // leftJoinAndSelect here — select only the display fields explicitly).
    queryBuilder
      .leftJoin('ord.createdByUser', 'creator')
      .addSelect(['creator.id', 'creator.firstName', 'creator.lastName'])
      .leftJoin('ord.createdByDevice', 'creatorDevice')
      .addSelect(['creatorDevice.id', 'creatorDevice.name']);

    this.applyOrderFilters(queryBuilder, 'ord', query);

    if (query.includeItems) {
      queryBuilder.leftJoinAndSelect('ord.items', 'items');
    }

    queryBuilder.orderBy('ord.createdAt', 'DESC').skip(skip).take(limit);

    const [items, total] = await queryBuilder.getManyAndCount();

    return createPaginatedResult(items, total, page, limit);
  }

  /**
   * Aggregate order stats (count/revenue/avgReceipt/pfand) over ALL orders
   * matching the given filters — no pagination. Mirrors the same money
   * semantics as the (soon to be removed) client-side summary in
   * orders-list.tsx: cancelled orders count toward `count` but are excluded
   * from every money sum, so `avgReceipt` divides by the non-cancelled count.
   */
  async getStats(
    organizationId: string,
    user: User,
    query: QueryOrdersDto,
  ): Promise<OrderStats> {
    await this.checkMembership(organizationId, user.id);

    const queryBuilder = this.orderRepository
      .createQueryBuilder('ord')
      .where('ord.organizationId = :organizationId', { organizationId });

    this.applyOrderFilters(queryBuilder, 'ord', query);

    const raw = await queryBuilder
      .select('COUNT(ord.id)', 'count')
      .addSelect(
        `COUNT(CASE WHEN ord.status != :cancelledStatus THEN ord.id END)`,
        'countedCount',
      )
      .addSelect(
        `COALESCE(SUM(CASE WHEN ord.status != :cancelledStatus THEN ord.total ELSE 0 END), 0)`,
        'revenue',
      )
      .addSelect(
        `COALESCE(SUM(CASE WHEN ord.status != :cancelledStatus THEN ord.pfandTotal ELSE 0 END), 0)`,
        'pfand',
      )
      .setParameter('cancelledStatus', OrderStatus.CANCELLED)
      .getRawOne<{
        count: string;
        countedCount: string;
        revenue: string;
        pfand: string;
      }>();

    const count = Number(raw?.count || 0);
    const countedCount = Number(raw?.countedCount || 0);
    const revenue = Number(raw?.revenue || 0);
    const pfand = Number(raw?.pfand || 0);

    return {
      count,
      revenue,
      avgReceipt: countedCount > 0 ? revenue / countedCount : 0,
      pfand,
    };
  }

  async findOne(
    organizationId: string,
    orderId: string,
    user: User,
  ): Promise<Order> {
    await this.checkMembership(organizationId, user.id);

    const order = await this.orderRepository.findOne({
      where: { id: orderId, organizationId },
      relations: ['items', 'items.product', 'createdByUser', 'event'],
    });

    if (!order) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Bestellung nicht gefunden',
      });
    }

    return order;
  }

  async update(
    organizationId: string,
    orderId: string,
    updateDto: UpdateOrderDto,
    user: User,
  ): Promise<Order> {
    await this.checkMembership(organizationId, user.id);

    const order = await this.findOne(organizationId, orderId, user);

    if (
      order.status === OrderStatus.COMPLETED ||
      order.status === OrderStatus.CANCELLED
    ) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message:
          'Abgeschlossene oder stornierte Bestellungen können nicht bearbeitet werden',
      });
    }

    Object.assign(order, updateDto);
    await this.orderRepository.save(order);

    // Recalculate totals if discount changed
    if (
      updateDto.discountAmount !== undefined ||
      updateDto.tipAmount !== undefined
    ) {
      await this.recalculateOrderTotals(order.id);
    }

    this.logger.log(`Order updated: ${order.orderNumber} (${order.id})`);

    return this.findOne(organizationId, orderId, user);
  }

  async remove(
    organizationId: string,
    orderId: string,
    user: User,
  ): Promise<void> {
    await this.checkMembership(organizationId, user.id);

    const order = await this.findOne(organizationId, orderId, user);

    if (order.paymentStatus !== PaymentStatus.UNPAID) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Bezahlte Bestellungen können nicht gelöscht werden',
      });
    }

    // Restore stock for all items
    for (const item of order.items) {
      await this.restoreStockForItem(item, user.id);
    }

    await this.orderRepository.softRemove(order);
    this.logger.log(`Order deleted: ${order.orderNumber} (${order.id})`);
  }

  // Order Items

  async addItem(
    organizationId: string,
    orderId: string,
    itemDto: AddOrderItemDto,
    user: User,
  ): Promise<Order> {
    await this.checkMembership(organizationId, user.id);

    const order = await this.findOne(organizationId, orderId, user);

    if (
      order.status === OrderStatus.COMPLETED ||
      order.status === OrderStatus.CANCELLED
    ) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message:
          'Abgeschlossene oder stornierte Bestellungen können nicht bearbeitet werden',
      });
    }

    const chargePfand = await this.shouldChargePfand(order);
    await this.addItemToOrder(order, itemDto, user, chargePfand);
    await this.recalculateOrderTotals(order.id);
    await this.updateOrderStatus(order.id);

    this.logger.log(`Item added to order: ${order.orderNumber}`);

    return this.findOne(organizationId, orderId, user);
  }

  async updateItem(
    organizationId: string,
    orderId: string,
    itemId: string,
    updateDto: UpdateOrderItemDto,
    user: User,
  ): Promise<Order> {
    await this.checkMembership(organizationId, user.id);

    const order = await this.findOne(organizationId, orderId, user);

    if (
      order.status === OrderStatus.COMPLETED ||
      order.status === OrderStatus.CANCELLED
    ) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message:
          'Abgeschlossene oder stornierte Bestellungen können nicht bearbeitet werden',
      });
    }

    const item = order.items.find((i) => i.id === itemId);
    if (!item) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Bestellposition nicht gefunden',
      });
    }

    if (item.status !== OrderItemStatus.PENDING) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Nur unbearbeitete Positionen können geändert werden',
      });
    }

    // Handle quantity change
    if (updateDto.quantity && updateDto.quantity !== item.quantity) {
      const quantityDiff = updateDto.quantity - item.quantity;

      // Update stock
      if (item.product?.trackInventory) {
        const product = await this.productRepository.findOne({
          where: { id: item.productId },
        });

        if (product) {
          if (quantityDiff > 0 && product.stockQuantity < quantityDiff) {
            throw new BadRequestException({
              code: ErrorCodes.VALIDATION_ERROR,
              message: `Nicht genügend Bestand für ${product.name}`,
            });
          }

          const previousQuantity = product.stockQuantity;
          product.stockQuantity -= quantityDiff;
          await this.productRepository.save(product);

          await this.createStockMovement(
            product,
            order.eventId!,
            -quantityDiff,
            previousQuantity,
            product.stockQuantity,
            quantityDiff > 0
              ? StockMovementType.SALE
              : StockMovementType.SALE_CANCELLED,
            'order',
            order.id,
            'Bestellungsänderung',
            user.id,
          );

          // Notify POS terminals about stock change
          const event = await this.eventRepository.findOne({
            where: { id: order.eventId! },
          });
          if (event) {
            this.gatewayService.notifyProductUpdated(
              event.organizationId,
              event.id,
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
      }

      item.quantity = updateDto.quantity;
      item.totalPrice =
        Number(item.unitPrice) * updateDto.quantity + Number(item.optionsPrice);
    }

    if (updateDto.notes !== undefined) {
      item.notes = updateDto.notes || null;
    }

    if (updateDto.kitchenNotes !== undefined) {
      item.kitchenNotes = updateDto.kitchenNotes || null;
    }

    await this.orderItemRepository.save(item);
    await this.recalculateOrderTotals(order.id);

    this.logger.log(`Item updated in order: ${order.orderNumber}`);

    return this.findOne(organizationId, orderId, user);
  }

  async removeItem(
    organizationId: string,
    orderId: string,
    itemId: string,
    user: User,
  ): Promise<Order> {
    await this.checkMembership(organizationId, user.id);

    const order = await this.findOne(organizationId, orderId, user);

    if (
      order.status === OrderStatus.COMPLETED ||
      order.status === OrderStatus.CANCELLED
    ) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message:
          'Abgeschlossene oder stornierte Bestellungen können nicht bearbeitet werden',
      });
    }

    const item = order.items.find((i) => i.id === itemId);
    if (!item) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Bestellposition nicht gefunden',
      });
    }

    if (item.paidQuantity > 0) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Bereits bezahlte Positionen können nicht entfernt werden',
      });
    }

    // Restore stock
    await this.restoreStockForItem(item, user.id);

    await this.orderItemRepository.remove(item);
    await this.recalculateOrderTotals(order.id);
    await this.updateOrderStatus(order.id);

    this.logger.log(`Item removed from order: ${order.orderNumber}`);

    return this.findOne(organizationId, orderId, user);
  }

  // Status Updates

  async markItemReady(
    organizationId: string,
    orderId: string,
    itemId: string,
    user: User,
  ): Promise<Order> {
    await this.checkMembership(organizationId, user.id);

    const order = await this.findOne(organizationId, orderId, user);
    const item = order.items.find((i) => i.id === itemId);

    if (!item) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Bestellposition nicht gefunden',
      });
    }

    if (item.status === OrderItemStatus.CANCELLED) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Stornierte Position kann nicht als fertig markiert werden',
      });
    }

    return this.processItemReady(organizationId, order, item);
  }

  async markItemReadyFromDevice(
    organizationId: string,
    itemId: string,
  ): Promise<Order> {
    const item = await this.orderItemRepository.findOne({
      where: { id: itemId },
      relations: ['order'],
    });

    if (!item) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Bestellposition nicht gefunden',
      });
    }

    if (!item.order || item.order.organizationId !== organizationId) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Kein Zugriff auf diese Bestellung',
      });
    }

    if (item.status === OrderItemStatus.CANCELLED) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Stornierte Position kann nicht als fertig markiert werden',
      });
    }

    const order = await this.orderRepository.findOne({
      where: { id: item.order.id, organizationId },
      relations: ['items', 'items.product', 'event'],
    });

    if (!order) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Bestellung nicht gefunden',
      });
    }

    return this.processItemReady(organizationId, order, item);
  }

  async markItemDelivered(
    organizationId: string,
    orderId: string,
    itemId: string,
    user: User,
  ): Promise<Order> {
    await this.checkMembership(organizationId, user.id);

    const order = await this.findOne(organizationId, orderId, user);
    const item = order.items.find((i) => i.id === itemId);

    if (!item) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Bestellposition nicht gefunden',
      });
    }

    item.status = OrderItemStatus.DELIVERED;
    item.deliveredAt = new Date();
    await this.orderItemRepository.save(item);
    await this.updateOrderStatus(order.id);

    this.logger.log(
      `Item marked delivered: ${item.id} in order ${order.orderNumber}`,
    );

    // Check if all items are delivered (collected)
    const updatedOrder = await this.findOne(organizationId, orderId, user);
    const activeItems = updatedOrder.items.filter(
      (i) => i.status !== OrderItemStatus.CANCELLED,
    );
    const allDelivered =
      activeItems.length > 0 &&
      activeItems.every((i) => i.status === OrderItemStatus.DELIVERED);

    if (allDelivered) {
      // Auto-complete if all delivered and fully paid
      if (updatedOrder.paymentStatus === PaymentStatus.PAID) {
        updatedOrder.status = OrderStatus.COMPLETED;
        updatedOrder.completedAt = new Date();
        await this.orderRepository.save(updatedOrder);
      }
    }

    return updatedOrder;
  }

  async callOrder(
    organizationId: string,
    orderId: string,
    user: User,
  ): Promise<Order> {
    await this.checkMembership(organizationId, user.id);

    const order = await this.findOne(organizationId, orderId, user);

    this.logger.log(`Order called: ${order.orderNumber}`);

    return order;
  }

  async completeOrder(
    organizationId: string,
    orderId: string,
    user: User,
  ): Promise<Order> {
    await this.checkMembership(organizationId, user.id);

    const order = await this.findOne(organizationId, orderId, user);

    if (order.status === OrderStatus.COMPLETED) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Bestellung ist bereits abgeschlossen',
      });
    }

    if (order.status === OrderStatus.CANCELLED) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Stornierte Bestellung kann nicht abgeschlossen werden',
      });
    }

    if (order.paymentStatus !== PaymentStatus.PAID) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Bestellung muss vollständig bezahlt sein',
      });
    }

    order.status = OrderStatus.COMPLETED;
    order.completedAt = new Date();
    await this.orderRepository.save(order);

    this.logger.log(`Order completed: ${order.orderNumber}`);

    const completedOrder = await this.findOne(organizationId, orderId, user);

    return completedOrder;
  }

  async cancelOrder(
    organizationId: string,
    orderId: string,
    cancelDto: CancelOrderDto,
    user: User,
  ): Promise<Order> {
    await this.checkMembership(organizationId, user.id);

    const order = await this.findOne(organizationId, orderId, user);

    if (order.status === OrderStatus.COMPLETED) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Abgeschlossene Bestellungen können nicht storniert werden',
      });
    }

    if (order.status === OrderStatus.CANCELLED) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Bestellung ist bereits storniert',
      });
    }

    // Restore stock for all items
    for (const item of order.items) {
      await this.restoreStockForItem(item, user.id);
      item.status = OrderItemStatus.CANCELLED;
      await this.orderItemRepository.save(item);
    }

    order.status = OrderStatus.CANCELLED;
    order.cancelledAt = new Date();
    order.cancellationReason = cancelDto.reason || null;
    await this.orderRepository.save(order);

    this.logger.log(`Order cancelled: ${order.orderNumber}`);

    return this.findOne(organizationId, orderId, user);
  }

  // Private helper methods

  /**
   * Applies the shared QueryOrdersDto filters (everything except pagination
   * and includeItems) to a query builder. Used by both findAll and getStats
   * so their result sets can never diverge.
   */
  private applyOrderFilters(
    queryBuilder: SelectQueryBuilder<Order>,
    alias: string,
    query: QueryOrdersDto,
  ): void {
    if (query.eventId) {
      queryBuilder.andWhere(`${alias}.eventId = :eventId`, {
        eventId: query.eventId,
      });
    }

    if (query.status) {
      queryBuilder.andWhere(`${alias}.status = :status`, {
        status: query.status,
      });
    }

    if (query.paymentStatus) {
      queryBuilder.andWhere(`${alias}.paymentStatus = :paymentStatus`, {
        paymentStatus: query.paymentStatus,
      });
    }

    if (query.source) {
      queryBuilder.andWhere(`${alias}.source = :source`, {
        source: query.source,
      });
    }

    if (query.fulfillmentType) {
      queryBuilder.andWhere(`${alias}.fulfillmentType = :fulfillmentType`, {
        fulfillmentType: query.fulfillmentType,
      });
    }

    if (query.dateFrom) {
      queryBuilder.andWhere(`${alias}.createdAt >= :dateFrom`, {
        dateFrom: query.dateFrom,
      });
    }

    if (query.dateTo) {
      queryBuilder.andWhere(`${alias}.createdAt <= :dateTo`, {
        dateTo: query.dateTo,
      });
    }
  }

  /** Whether deposits apply to this order, per the org's fulfillment-type policy. */
  private async shouldChargePfand(order: Order): Promise<boolean> {
    const organization = await this.organizationRepository.findOne({
      where: { id: order.organizationId },
    });
    return isPfandChargedForFulfillment(
      order.fulfillmentType,
      organization?.settings,
    );
  }

  private async addItemToOrder(
    order: Order,
    itemDto:
      | AddOrderItemDto
      | {
          productId: string;
          quantity: number;
          notes?: string;
          kitchenNotes?: string;
          selectedOptions?: any[];
          isRefill?: boolean;
        },
    user: User,
    chargePfand = true,
  ): Promise<OrderItem> {
    const product = await this.productRepository.findOne({
      where: { id: itemDto.productId, eventId: order.eventId! },
      relations: ['category', 'pfandType'],
    });

    if (!product) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Produkt nicht gefunden',
      });
    }

    if (!product.isActive || !product.isAvailable) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Produkt ${product.name} ist nicht verfügbar`,
      });
    }

    // Check stock
    if (product.trackInventory && product.stockQuantity < itemDto.quantity) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Nicht genügend Bestand für ${product.name}`,
      });
    }

    // Calculate options price
    let optionsPrice = 0;
    const selectedOptions = itemDto.selectedOptions || [];
    for (const opt of selectedOptions) {
      optionsPrice += opt.priceModifier || 0;
    }

    const unitPrice = Number(product.price);
    const totalPrice = (unitPrice + optionsPrice) * itemDto.quantity;

    // Resolve deposit (Pfand): charged per unit unless this is a refill or the
    // order's fulfillment type is exempt (e.g. table service).
    const isRefill = itemDto.isRefill === true;
    const depositAmount =
      chargePfand && !isRefill && product.pfandType
        ? Number(product.pfandType.amount)
        : 0;
    const pfandTypeId = depositAmount > 0 ? product.pfandTypeId : null;

    // Determine the next sort order
    const existingItems = await this.orderItemRepository.count({
      where: { orderId: order.id },
    });

    // Resolve production station: product overrides category
    const productionStationId =
      product.productionStationId ||
      product.category?.productionStationId ||
      null;

    const item = this.orderItemRepository.create({
      orderId: order.id,
      productId: product.id,
      categoryId: product.categoryId,
      productName: product.name,
      categoryName: product.category?.name || '',
      quantity: itemDto.quantity,
      unitPrice,
      optionsPrice,
      taxRate: 19.0, // Default German VAT rate
      totalPrice,
      options: { selected: selectedOptions },
      notes: itemDto.notes || null,
      kitchenNotes: itemDto.kitchenNotes || null,
      status: OrderItemStatus.PENDING,
      sortOrder: existingItems,
      productionStationId,
      pfandTypeId,
      depositAmount,
      isRefill,
    });

    await this.orderItemRepository.save(item);

    // Update stock
    if (product.trackInventory) {
      const previousQuantity = product.stockQuantity;
      product.stockQuantity -= itemDto.quantity;
      await this.productRepository.save(product);

      await this.createStockMovement(
        product,
        order.eventId!,
        -itemDto.quantity,
        previousQuantity,
        product.stockQuantity,
        StockMovementType.SALE,
        'order',
        order.id,
        'Bestellung',
        user.id,
      );

      // Notify POS terminals about stock change
      const event = await this.eventRepository.findOne({
        where: { id: order.eventId! },
      });
      if (event) {
        this.gatewayService.notifyProductUpdated(
          event.organizationId,
          event.id,
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

    return item;
  }

  private async restoreStockForItem(
    item: OrderItem,
    userId: string,
  ): Promise<void> {
    const product = await this.productRepository.findOne({
      where: { id: item.productId },
    });

    if (product?.trackInventory) {
      const previousQuantity = product.stockQuantity;
      product.stockQuantity += item.quantity;
      await this.productRepository.save(product);

      const order = await this.orderRepository.findOne({
        where: { id: item.orderId },
      });

      if (order) {
        await this.createStockMovement(
          product,
          order.eventId!,
          item.quantity,
          previousQuantity,
          product.stockQuantity,
          StockMovementType.SALE_CANCELLED,
          'order',
          order.id,
          'Stornierung',
          userId,
        );

        // Notify POS terminals about stock restoration
        const event = await this.eventRepository.findOne({
          where: { id: order.eventId! },
        });
        if (event) {
          this.gatewayService.notifyProductUpdated(
            event.organizationId,
            event.id,
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
    }
  }

  private async createStockMovement(
    product: Product,
    eventId: string,
    quantity: number,
    quantityBefore: number,
    quantityAfter: number,
    type: StockMovementType,
    referenceType: string,
    referenceId: string,
    reason: string,
    userId: string,
  ): Promise<void> {
    const movement = this.stockMovementRepository.create({
      productId: product.id,
      eventId,
      quantity,
      quantityBefore,
      quantityAfter,
      type,
      referenceType,
      referenceId,
      reason,
      createdByUserId: userId,
    });
    await this.stockMovementRepository.save(movement);
  }

  private async processItemReady(
    organizationId: string,
    order: Order,
    item: OrderItem,
  ): Promise<Order> {
    const previousStatus = item.status;
    item.status = OrderItemStatus.READY;
    item.readyAt = new Date();
    await this.orderItemRepository.save(item);

    this.logger.log(
      `Item marked ready: ${item.id} in order ${order.orderNumber}`,
    );

    await this.updateOrderStatus(order.id);

    return this.reloadOrder(organizationId, order.id);
  }

  private async reloadOrder(
    organizationId: string,
    orderId: string,
  ): Promise<Order> {
    const order = await this.orderRepository.findOne({
      where: { id: orderId, organizationId },
      relations: ['items', 'items.product', 'createdByUser', 'event'],
    });

    if (!order) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Bestellung nicht gefunden',
      });
    }

    return order;
  }

  private async printToStation(
    organizationId: string,
    station: ProductionStation,
    order: Order,
    items: OrderItem[],
  ): Promise<void> {
    if (!station.printerId) return;

    try {
      await this.printJobsService.createFromWorkflow(
        organizationId,
        station.printerId,
        null,
        order.id,
        1,
        {
          order,
          orderNumber: order.orderNumber,
          dailyNumber: order.dailyNumber,
          tableNumber: order.tableNumber,
          stationName: station.name,
          items: items.map((i) => ({
            productName: i.productName,
            categoryName: i.categoryName,
            quantity: i.quantity,
            notes: i.notes,
            kitchenNotes: i.kitchenNotes,
            options: i.options,
          })),
        },
      );
    } catch (err) {
      this.logger.error(
        `Station printing failed for ${station.name}: ${err.message}`,
      );
    }
  }

  private async recalculateOrderTotals(orderId: string): Promise<void> {
    const order = await this.orderRepository.findOne({
      where: { id: orderId },
      relations: ['items'],
    });

    if (!order) return;

    let subtotal = 0;
    let taxTotal = 0;
    let pfandTotal = 0;

    for (const item of order.items) {
      if (item.status !== OrderItemStatus.CANCELLED) {
        subtotal += Number(item.totalPrice);
        taxTotal += Number(item.totalPrice) * (Number(item.taxRate) / 100);
        pfandTotal += Number(item.depositAmount) * item.quantity;
      }
    }

    order.subtotal = subtotal;
    order.taxTotal = taxTotal;
    order.pfandTotal = pfandTotal;

    // Cap the discount at the subtotal so the order total can never go negative —
    // any voucher value beyond the order amount is forfeited (not paid out).
    // Pfand (deposit) is added on top and is tax-free (not part of subtotal/taxTotal).
    const effectiveDiscount = Math.min(Number(order.discountAmount), subtotal);
    order.discountAmount = effectiveDiscount;
    order.total =
      subtotal - effectiveDiscount + Number(order.tipAmount) + pfandTotal;

    await this.orderRepository.save(order);
  }

  private async updateOrderStatus(orderId: string): Promise<void> {
    const order = await this.orderRepository.findOne({
      where: { id: orderId },
      relations: ['items'],
    });

    if (!order) return;

    const activeItems = order.items.filter(
      (i) => i.status !== OrderItemStatus.CANCELLED,
    );

    if (activeItems.length === 0) {
      order.status = OrderStatus.OPEN;
    } else if (
      activeItems.every((i) => i.status === OrderItemStatus.DELIVERED)
    ) {
      order.status = OrderStatus.READY;
    } else if (activeItems.some((i) => i.status !== OrderItemStatus.PENDING)) {
      order.status = OrderStatus.IN_PROGRESS;
    }

    await this.orderRepository.save(order);
  }

  private async generateOrderNumber(organizationId: string): Promise<string> {
    const date = new Date();
    const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');

    // Get count of orders for today
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const count = await this.orderRepository.count({
      where: {
        organizationId,
        createdAt: Between(startOfDay, endOfDay),
      },
    });

    return `${dateStr}-${String(count + 1).padStart(4, '0')}`;
  }

  private async getDailyNumber(
    organizationId: string,
    eventId: string | null,
  ): Promise<number> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const count = await this.orderRepository.count({
      where: {
        organizationId,
        eventId: eventId || undefined,
        createdAt: MoreThanOrEqual(startOfDay),
      },
    });

    return count + 1;
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
        message: 'Kein Zugriff auf diese Organisation',
      });
    }
  }
}
