import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  ParseUUIDPipe,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, MoreThanOrEqual, In } from 'typeorm';
import { DeviceAuthGuard } from '../../common/guards/device-auth.guard';
import { CurrentDevice } from '../../common/decorators';
import {
  Device,
  Event,
  Category,
  Product,
  Order,
  OrderItem,
  Payment,
  Organization,
} from '../../database/entities';
import { EventStatus } from '../../database/entities/event.entity';
import { OrderStatus, PaymentStatus, OrderSource } from '../../database/entities/order.entity';
import { OrderItemStatus } from '../../database/entities/order-item.entity';
import {
  PaymentMethod,
  PaymentProvider,
  PaymentTransactionStatus,
} from '../../database/entities/payment.entity';
import { Public } from '../../common/decorators/public.decorator';
import { ErrorCodes } from '../../common/constants/error-codes';
import { CreateOrderDto } from '../orders/dto';
import { CreatePaymentDto } from '../payments/dto';

@ApiTags('Device API')
@ApiHeader({
  name: 'X-Device-Token',
  description: 'Device authentication token',
  required: true,
})
@Controller('device-api')
@Public() // Exclude from JWT guard
@UseGuards(DeviceAuthGuard)
export class DeviceApiController {
  private readonly logger = new Logger(DeviceApiController.name);

  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(OrderItem)
    private readonly orderItemRepository: Repository<OrderItem>,
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
  ) {}

  @Get('organization')
  @ApiOperation({ summary: 'Get organization info and settings for device' })
  async getOrganization(@CurrentDevice() device: Device) {
    const organization = await this.organizationRepository.findOne({
      where: { id: device.organizationId },
    });

    if (!organization) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }

    // Return only the settings relevant for the device
    return {
      data: {
        id: organization.id,
        name: organization.name,
        settings: organization.settings,
      },
    };
  }

  @Get('events')
  @ApiOperation({ summary: 'Get active events for device organization' })
  async getEvents(@CurrentDevice() device: Device) {
    const events = await this.eventRepository.find({
      where: {
        organizationId: device.organizationId,
        status: EventStatus.ACTIVE,
      },
      order: { startDate: 'ASC' },
    });

    return { data: events };
  }

  @Get('events/:eventId')
  @ApiOperation({ summary: 'Get single event' })
  async getEvent(
    @CurrentDevice() device: Device,
    @Param('eventId', ParseUUIDPipe) eventId: string,
  ) {
    const event = await this.eventRepository.findOne({
      where: {
        id: eventId,
        organizationId: device.organizationId,
      },
    });

    if (!event) {
      return { data: null };
    }

    return { data: event };
  }

  @Get('events/:eventId/categories')
  @ApiOperation({ summary: 'Get categories for an event' })
  async getCategories(
    @CurrentDevice() device: Device,
    @Param('eventId', ParseUUIDPipe) eventId: string,
  ) {
    // Verify event belongs to device's organization
    const event = await this.eventRepository.findOne({
      where: { id: eventId, organizationId: device.organizationId },
    });

    if (!event) {
      return { data: [] };
    }

    const categories = await this.categoryRepository.find({
      where: { eventId },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });

    return { data: categories };
  }

  @Get('events/:eventId/products')
  @ApiOperation({ summary: 'Get products for an event' })
  async getProducts(
    @CurrentDevice() device: Device,
    @Param('eventId', ParseUUIDPipe) eventId: string,
  ) {
    // Verify event belongs to device's organization
    const event = await this.eventRepository.findOne({
      where: { id: eventId, organizationId: device.organizationId },
    });

    if (!event) {
      return { data: [] };
    }

    const products = await this.productRepository.find({
      where: { eventId, isActive: true },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });

    return { data: products };
  }

  // Order endpoints

  @Get('orders/open')
  @ApiOperation({ summary: 'Get open (unpaid/partly paid) orders for device organization' })
  async getOpenOrders(@CurrentDevice() device: Device) {
    const orders = await this.orderRepository.find({
      where: {
        organizationId: device.organizationId,
        paymentStatus: In([PaymentStatus.UNPAID, PaymentStatus.PARTLY_PAID]),
        status: In([OrderStatus.OPEN, OrderStatus.IN_PROGRESS]),
      },
      relations: ['items'],
      order: { createdAt: 'DESC' },
    });

    return { data: orders };
  }

  @Post('orders')
  @ApiOperation({ summary: 'Create a new order from device' })
  async createOrder(
    @CurrentDevice() device: Device,
    @Body() createDto: CreateOrderDto,
  ) {
    const organizationId = device.organizationId;

    // Validate event
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

      if (event.status !== EventStatus.ACTIVE) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Event ist nicht aktiv',
        });
      }
    }

    // Generate order number
    const orderNumber = await this.generateOrderNumber(organizationId);
    const dailyNumber = await this.getDailyNumber(organizationId, createDto.eventId || null);

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
      createdByDeviceId: device.id,
      status: OrderStatus.OPEN,
      paymentStatus: PaymentStatus.UNPAID,
    });

    await this.orderRepository.save(order);

    // Add items if provided
    if (createDto.items && createDto.items.length > 0) {
      for (const itemDto of createDto.items) {
        await this.addItemToOrder(order, itemDto);
      }

      // Recalculate totals
      await this.recalculateOrderTotals(order.id);
    }

    this.logger.log(`Device order created: ${order.orderNumber} (${order.id}) by device ${device.name}`);

    // Fetch the complete order with items
    const completeOrder = await this.orderRepository.findOne({
      where: { id: order.id },
      relations: ['items'],
    });

    return { data: completeOrder };
  }

  @Post('payments')
  @ApiOperation({ summary: 'Create a payment for an order from device' })
  async createPayment(
    @CurrentDevice() device: Device,
    @Body() createDto: CreatePaymentDto,
  ) {
    const organizationId = device.organizationId;

    const order = await this.orderRepository.findOne({
      where: { id: createDto.orderId, organizationId },
      relations: ['items'],
    });

    if (!order) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Bestellung nicht gefunden',
      });
    }

    if (order.paymentStatus === PaymentStatus.PAID) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Bestellung ist bereits vollständig bezahlt',
      });
    }

    const remainingAmount = Number(order.total) - Number(order.paidAmount);
    if (createDto.amount > remainingAmount + 0.01) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Zahlungsbetrag (${createDto.amount}) übersteigt den ausstehenden Betrag (${remainingAmount})`,
      });
    }

    const provider = this.getProviderForMethod(createDto.paymentMethod);

    const payment = this.paymentRepository.create({
      orderId: createDto.orderId,
      amount: createDto.amount,
      paymentMethod: createDto.paymentMethod,
      paymentProvider: provider,
      providerTransactionId: null,
      status: PaymentTransactionStatus.CAPTURED,
      metadata: {},
      processedByDeviceId: device.id,
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

      // Auto-complete the order
      order.status = OrderStatus.COMPLETED;
      order.completedAt = new Date();
      await this.orderRepository.save(order);
    }

    this.logger.log(`Device payment created: ${payment.id} for order ${order.orderNumber}`);

    return { data: payment };
  }

  @Post('payments/split')
  @ApiOperation({ summary: 'Create a split payment for specific items from device' })
  async createSplitPayment(
    @CurrentDevice() device: Device,
    @Body() createDto: {
      orderId: string;
      amount: number;
      paymentMethod: PaymentMethod;
      items: Array<{ orderItemId: string; quantity: number }>;
    },
  ) {
    const organizationId = device.organizationId;

    const order = await this.orderRepository.findOne({
      where: { id: createDto.orderId, organizationId },
      relations: ['items'],
    });

    if (!order) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Bestellung nicht gefunden',
      });
    }

    if (order.paymentStatus === PaymentStatus.PAID) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Bestellung ist bereits vollständig bezahlt',
      });
    }

    // Validate items and calculate expected amount
    let expectedAmount = 0;
    const itemsToUpdate: { item: OrderItem; payQty: number }[] = [];

    for (const itemDto of createDto.items) {
      const item = order.items.find((i) => i.id === itemDto.orderItemId);
      if (!item) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: `Artikel nicht gefunden: ${itemDto.orderItemId}`,
        });
      }

      const unpaidQty = item.quantity - (item.paidQuantity || 0);
      if (itemDto.quantity > unpaidQty) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: `Nicht genug unbezahlte Menge für ${item.productName}`,
        });
      }

      const itemPrice = Number(item.unitPrice) + Number(item.optionsPrice || 0);
      expectedAmount += itemPrice * itemDto.quantity;
      itemsToUpdate.push({ item, payQty: itemDto.quantity });
    }

    // Verify amount matches
    if (Math.abs(createDto.amount - expectedAmount) > 0.01) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Betrag stimmt nicht überein. Erwartet: ${expectedAmount}, Erhalten: ${createDto.amount}`,
      });
    }

    const provider = this.getProviderForMethod(createDto.paymentMethod);

    // Create payment
    const payment = this.paymentRepository.create({
      orderId: createDto.orderId,
      amount: createDto.amount,
      paymentMethod: createDto.paymentMethod,
      paymentProvider: provider,
      providerTransactionId: null,
      status: PaymentTransactionStatus.CAPTURED,
      metadata: { splitItems: createDto.items },
      processedByDeviceId: device.id,
    });

    await this.paymentRepository.save(payment);

    // Update order paid amount
    order.paidAmount = Number(order.paidAmount) + createDto.amount;

    // Update item paid quantities
    for (const { item, payQty } of itemsToUpdate) {
      item.paidQuantity = (item.paidQuantity || 0) + payQty;
      await this.orderItemRepository.save(item);
    }

    await this.updateOrderPaymentStatus(order);

    // Check if fully paid
    const isFullyPaid = Number(order.paidAmount) >= Number(order.total);
    if (isFullyPaid) {
      order.status = OrderStatus.COMPLETED;
      order.completedAt = new Date();
      await this.orderRepository.save(order);
    }

    this.logger.log(`Device split payment created: ${payment.id} for order ${order.orderNumber}`);

    return { data: payment };
  }

  // Private helper methods

  private async addItemToOrder(
    order: Order,
    itemDto: { productId: string; quantity: number; notes?: string; kitchenNotes?: string; selectedOptions?: any[] },
  ): Promise<OrderItem> {
    const product = await this.productRepository.findOne({
      where: { id: itemDto.productId, eventId: order.eventId! },
      relations: ['category'],
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

    // Determine the next sort order
    const existingItems = await this.orderItemRepository.count({
      where: { orderId: order.id },
    });

    const item = this.orderItemRepository.create({
      orderId: order.id,
      productId: product.id,
      categoryId: product.categoryId,
      productName: product.name,
      categoryName: product.category?.name || '',
      quantity: itemDto.quantity,
      unitPrice,
      optionsPrice,
      taxRate: 19.0,
      totalPrice,
      options: { selected: selectedOptions },
      notes: itemDto.notes || null,
      kitchenNotes: itemDto.kitchenNotes || null,
      status: OrderItemStatus.PENDING,
      sortOrder: existingItems,
    });

    await this.orderItemRepository.save(item);

    // Update stock
    if (product.trackInventory) {
      product.stockQuantity -= itemDto.quantity;
      await this.productRepository.save(product);
    }

    return item;
  }

  private async recalculateOrderTotals(orderId: string): Promise<void> {
    const order = await this.orderRepository.findOne({
      where: { id: orderId },
      relations: ['items'],
    });

    if (!order) return;

    let subtotal = 0;
    let taxTotal = 0;

    for (const item of order.items) {
      if (item.status !== OrderItemStatus.CANCELLED) {
        subtotal += Number(item.totalPrice);
        taxTotal += Number(item.totalPrice) * (Number(item.taxRate) / 100);
      }
    }

    order.subtotal = subtotal;
    order.taxTotal = taxTotal;
    order.total = subtotal - Number(order.discountAmount || 0) + Number(order.tipAmount || 0);

    await this.orderRepository.save(order);
  }

  private async updateOrderPaymentStatus(order: Order): Promise<void> {
    const paidAmount = Number(order.paidAmount);
    const total = Number(order.total);

    if (paidAmount >= total) {
      order.paymentStatus = PaymentStatus.PAID;
    } else if (paidAmount > 0) {
      order.paymentStatus = PaymentStatus.PARTLY_PAID;
    } else {
      order.paymentStatus = PaymentStatus.UNPAID;
    }

    await this.orderRepository.save(order);
  }

  private async generateOrderNumber(organizationId: string): Promise<string> {
    const date = new Date();
    const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');

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

  private async getDailyNumber(organizationId: string, eventId: string | null): Promise<number> {
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

  private getProviderForMethod(method: PaymentMethod): PaymentProvider {
    switch (method) {
      case PaymentMethod.CASH:
        return PaymentProvider.CASH;
      case PaymentMethod.CARD:
        return PaymentProvider.CARD;
      default:
        return PaymentProvider.CASH;
    }
  }
}
