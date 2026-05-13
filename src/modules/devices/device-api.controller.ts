import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, MoreThanOrEqual, In } from 'typeorm';
import { DeviceAuthGuard } from '../../common/guards/device-auth.guard';
import { CurrentDevice } from '../../common/decorators';
import { DevicesService } from './devices.service';
import { VerifyPinDto } from './dto';
import {
  Device,
  Event,
  Category,
  Product,
  Order,
  OrderItem,
  Payment,
  Organization,
  Printer,
  PrintTemplate,
  StockMovement,
  ProductionStation,
} from '../../database/entities';
import { EventStatus } from '../../database/entities/event.entity';
import { PrinterType, PrinterConnectionType } from '../../database/entities/printer.entity';
import { OrderStatus, PaymentStatus, OrderSource, OrderFulfillmentType } from '../../database/entities/order.entity';
import { OrderItemStatus } from '../../database/entities/order-item.entity';
import { StockMovementType } from '../../database/entities/stock-movement.entity';
import {
  PaymentMethod,
  PaymentProvider,
  PaymentTransactionStatus,
} from '../../database/entities/payment.entity';
import { Public } from '../../common/decorators/public.decorator';
import { ErrorCodes } from '../../common/constants/error-codes';
import { DeviceSettings } from '../../database/entities/device.entity';
import { CreateOrderDto } from '../orders/dto';
import { CreatePaymentDto } from '../payments/dto';
import { SumUpApiService } from '../sumup/sumup-api.service';
import { PrintersService } from '../printers/printers.service';
import { GatewayService } from '../gateway/gateway.service';
import { OrderPrintService } from '../print-jobs/order-print.service';
import { PrintJobsService } from '../print-jobs/print-jobs.service';
import { OrdersService } from '../orders/orders.service';

/**
 * Helper to ensure device has an organization.
 * Returns the organizationId as string (non-null).
 */
function requireOrganization(device: Device): string {
  if (!device.organizationId) {
    throw new ForbiddenException({
      code: ErrorCodes.FORBIDDEN,
      message: 'Gerät ist keiner Organisation zugeordnet',
    });
  }
  return device.organizationId;
}

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
    @InjectRepository(PrintTemplate)
    private readonly printTemplateRepository: Repository<PrintTemplate>,
    @InjectRepository(Printer)
    private readonly printerRepository: Repository<Printer>,
    @InjectRepository(StockMovement)
    private readonly stockMovementRepository: Repository<StockMovement>,
    @InjectRepository(ProductionStation)
    private readonly productionStationRepository: Repository<ProductionStation>,
    private readonly sumupApiService: SumUpApiService,
    private readonly devicesService: DevicesService,
    private readonly printersService: PrintersService,
    private readonly gatewayService: GatewayService,
    private readonly orderPrintService: OrderPrintService,
    private readonly printJobsService: PrintJobsService,
    private readonly ordersService: OrdersService,
  ) {}

  @Get('organization')
  @ApiOperation({ summary: 'Get organization info and settings for device' })
  async getOrganization(@CurrentDevice() device: Device) {
    const organizationId = requireOrganization(device);
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
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

  @Get('printers')
  @ApiOperation({ summary: 'Get printer configurations assigned to this device' })
  async getPrinters(@CurrentDevice() device: Device) {
    const printers = await this.printersService.findByDeviceId(device.id);

    return {
      data: {
        printers: printers.map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          connectionType: p.connectionType,
          connectionConfig: p.connectionConfig,
          paperWidth: p.paperWidth,
          hasCashDrawer: p.hasCashDrawer,
          isActive: p.isActive,
        })),
      },
    };
  }

  @Post('printers/sync')
  @ApiOperation({
    summary: 'Sync agent-side printer configuration to the backend',
    description:
      'Agent posts its local config.yaml printer block; the backend upserts the matching Printer rows and returns canonical IDs.',
  })
  async syncPrinters(
    @CurrentDevice() device: Device,
    @Body()
    body: {
      printers: Array<{
        localId: string;
        name: string;
        type: 'receipt' | 'kitchen' | 'label';
        connectionType: 'usb' | 'network' | 'bluetooth';
        connectionConfig?: Record<string, unknown>;
        paperWidth?: number;
      }>;
    },
  ) {
    const items = (body?.printers ?? []).map((p) => ({
      localId: p.localId,
      name: p.name,
      type: p.type as PrinterType,
      connectionType: p.connectionType as PrinterConnectionType,
      connectionConfig: p.connectionConfig,
      paperWidth: p.paperWidth,
    }));
    const result = await this.printersService.syncFromAgent(
      device.id,
      device.organizationId ?? null,
      items,
    );
    return { data: { printers: result } };
  }

  @Get('templates')
  @ApiOperation({ summary: 'Get print templates for this device' })
  async getTemplates(@CurrentDevice() device: Device) {
    const organizationId = requireOrganization(device);

    const templates = await this.printTemplateRepository.find({
      where: { organizationId },
    });

    // The printer agent expects the *rendered* Jinja2 source string, not the
    // designer's design-object. We persisted both: `t.template` is the design
    // shape `{ paperWidth, elements, generatedTemplate }`. Extract the source
    // and fall back to skipping if not yet generated.
    const templateMap: Record<string, string> = {};
    for (const t of templates) {
      const tpl = t.template as { generatedTemplate?: string } | string | null;
      if (typeof tpl === 'string') {
        templateMap[t.type] = tpl;
      } else if (tpl && typeof tpl.generatedTemplate === 'string') {
        templateMap[t.type] = tpl.generatedTemplate;
      }
      // else: skip — agent falls back to its built-in template for this type.
    }

    return {
      data: {
        templates: templateMap,
      },
    };
  }

  @Post('verify-pin')
  @ApiOperation({ summary: 'Verify a member PIN from device' })
  async verifyPin(
    @CurrentDevice() device: Device,
    @Body() verifyPinDto: VerifyPinDto,
  ) {
    const organizationId = requireOrganization(device);
    const result = await this.devicesService.verifyPin(organizationId, verifyPinDto.pin);
    return { data: result };
  }

  @Get('events')
  @ApiOperation({ summary: 'Get active or test event for device organization (at most one)' })
  async getEvents(@CurrentDevice() device: Device) {
    const organizationId = requireOrganization(device);
    const events = await this.eventRepository.find({
      where: {
        organizationId,
        status: In([EventStatus.ACTIVE, EventStatus.TEST]),
      },
      order: { status: 'ASC' },
    });

    return { data: events };
  }

  @Get('events/:eventId')
  @ApiOperation({ summary: 'Get single event' })
  async getEvent(
    @CurrentDevice() device: Device,
    @Param('eventId', ParseUUIDPipe) eventId: string,
  ) {
    const organizationId = requireOrganization(device);
    const event = await this.eventRepository.findOne({
      where: {
        id: eventId,
        organizationId,
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
    const organizationId = requireOrganization(device);
    // Verify event belongs to device's organization
    const event = await this.eventRepository.findOne({
      where: { id: eventId, organizationId },
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
    const organizationId = requireOrganization(device);
    // Verify event belongs to device's organization
    const event = await this.eventRepository.findOne({
      where: { id: eventId, organizationId },
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
    const organizationId = requireOrganization(device);
    const orders = await this.orderRepository.find({
      where: {
        organizationId,
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
    const organizationId = requireOrganization(device);

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

      if (event.status !== EventStatus.ACTIVE && event.status !== EventStatus.TEST) {
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
      fulfillmentType: device.settings?.serviceMode === 'table'
        ? OrderFulfillmentType.TABLE_SERVICE
        : OrderFulfillmentType.COUNTER_PICKUP,
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

    // Print station tickets and notify admin order list
    if (completeOrder && completeOrder.items && completeOrder.items.length > 0) {
      // Group items by production station for printing
      const itemsByStation = new Map<string | null, OrderItem[]>();
      for (const item of completeOrder.items) {
        const key = item.productionStationId || null;
        if (!itemsByStation.has(key)) itemsByStation.set(key, []);
        itemsByStation.get(key)!.push(item);
      }

      for (const [stationId, items] of itemsByStation) {
        if (stationId) {
          const station = await this.productionStationRepository.findOne({ where: { id: stationId } });
          if (station && station.printerId) {
            this.printToStation(organizationId, station, completeOrder, items);
          }
        }
      }

      // Notify admin order list
      this.gatewayService.notifyOrderCreated(organizationId, completeOrder.eventId, {
        id: completeOrder.id,
        orderNumber: completeOrder.orderNumber,
        dailyNumber: completeOrder.dailyNumber,
        tableNumber: completeOrder.tableNumber || undefined,
        customerName: completeOrder.customerName || undefined,
        status: completeOrder.status,
        fulfillmentType: completeOrder.fulfillmentType,
        source: completeOrder.source,
        items: completeOrder.items.map((item) => ({
          id: item.id,
          productName: item.productName,
          quantity: item.quantity,
          status: item.status,
          notes: item.notes || undefined,
          kitchenNotes: item.kitchenNotes || undefined,
        })),
      });

      // Auto-print kitchen / order tickets according to org orderFlow,
      // with fallback to the device's defaultPrinterId.
      this.orderPrintService
        .handleOrderCreated(organizationId, {
          order: completeOrder,
          orderId: completeOrder.id,
          orderNumber: completeOrder.orderNumber,
          tableNumber: completeOrder.tableNumber,
          total: Number(completeOrder.total),
          source: completeOrder.source,
        })
        .catch((err) =>
          this.logger.error(
            `Auto-print on device order ${completeOrder.id} failed: ${(err as Error).message}`,
          ),
        );
    }

    return { data: completeOrder };
  }

  @Post('payments')
  @ApiOperation({ summary: 'Create a payment for an order from device' })
  async createPayment(
    @CurrentDevice() device: Device,
    @Body() createDto: CreatePaymentDto,
  ) {
    const organizationId = requireOrganization(device);

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

      // Only auto-complete if no active station workflow is running
      const activeItems = order.items.filter(i => i.status !== OrderItemStatus.CANCELLED);
      const allWorkflowDone = activeItems.every(i =>
        !i.productionStationId || i.status === OrderItemStatus.DELIVERED,
      );

      if (allWorkflowDone) {
        order.status = OrderStatus.COMPLETED;
        order.completedAt = new Date();
        await this.orderRepository.save(order);
      }
    }

    this.logger.log(`Device payment created: ${payment.id} for order ${order.orderNumber}`);

    // Auto-open cash drawer on cash payment
    if (createDto.paymentMethod === PaymentMethod.CASH) {
      try {
        const cashDrawerPrinterId = device.settings?.cashDrawerPrinterId as string | undefined;
        if (cashDrawerPrinterId) {
          this.gatewayService.sendOpenCashDrawer(organizationId, cashDrawerPrinterId);
        }
      } catch (e) {
        this.logger.warn(`Failed to open cash drawer: ${e}`);
      }
    }

    // Auto-print receipt on payment_received trigger (with device fallback).
    this.orderPrintService
      .handlePaymentReceived(organizationId, {
        orderId: order.id,
        orderNumber: order.orderNumber,
        paymentId: payment.id,
        amount: Number(payment.amount),
        paymentMethod: payment.paymentMethod,
        isFullyPaid,
        order,
      })
      .catch((err) =>
        this.logger.error(
          `Auto-receipt on payment ${payment.id} failed: ${(err as Error).message}`,
        ),
      );

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
    const organizationId = requireOrganization(device);

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
      // Only auto-complete if no active station workflow is running
      const activeItems = order.items.filter(i => i.status !== OrderItemStatus.CANCELLED);
      const allWorkflowDone = activeItems.every(i =>
        !i.productionStationId || i.status === OrderItemStatus.DELIVERED,
      );

      if (allWorkflowDone) {
        order.status = OrderStatus.COMPLETED;
        order.completedAt = new Date();
        await this.orderRepository.save(order);
      }
    }

    this.logger.log(`Device split payment created: ${payment.id} for order ${order.orderNumber}`);

    // Auto-open cash drawer on cash payment
    if (createDto.paymentMethod === PaymentMethod.CASH) {
      try {
        const cashDrawerPrinterId = device.settings?.cashDrawerPrinterId as string | undefined;
        if (cashDrawerPrinterId) {
          this.gatewayService.sendOpenCashDrawer(organizationId, cashDrawerPrinterId);
        }
      } catch (e) {
        this.logger.warn(`Failed to open cash drawer: ${e}`);
      }
    }

    return { data: payment };
  }

  // Cash Drawer

  @Post('cash-drawer/open')
  @ApiOperation({ summary: 'Open the cash drawer via configured printer' })
  async openCashDrawer(@CurrentDevice() device: Device) {
    const organizationId = requireOrganization(device);
    const cashDrawerPrinterId = device.settings?.cashDrawerPrinterId as string | undefined;

    if (!cashDrawerPrinterId) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Keine Kassenschublade konfiguriert',
      });
    }

    const printer = await this.printerRepository.findOne({
      where: { id: cashDrawerPrinterId, organizationId },
    });

    if (!printer) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Drucker nicht gefunden',
      });
    }

    if (!printer.hasCashDrawer) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Drucker hat keine Kassenschublade',
      });
    }

    if (!printer.isActive) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Drucker ist nicht aktiv',
      });
    }

    this.gatewayService.sendOpenCashDrawer(organizationId, cashDrawerPrinterId);

    return { data: { success: true } };
  }

  // SumUp endpoints

  @Post('sumup/checkout')
  @ApiOperation({ summary: 'Initiate SumUp checkout on linked card reader' })
  async initiateSumupCheckout(
    @CurrentDevice() device: Device,
    @Body() body: { amount: number; currency?: string },
  ) {
    const organizationId = requireOrganization(device);
    const readerId = device.settings?.sumupReaderId;
    if (!readerId) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Kein Kartenleser mit diesem Gerät verknüpft',
      });
    }

    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
    });
    if (!organization) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }

    const sumupSettings = (organization.settings as any)?.sumup;
    if (!sumupSettings?.apiKey || !sumupSettings?.merchantCode) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'SumUp ist nicht für diese Organisation konfiguriert',
      });
    }

    const result = await this.sumupApiService.initiateCheckout(
      sumupSettings.apiKey,
      sumupSettings.merchantCode,
      readerId,
      { amount: body.amount, currency: body.currency || 'EUR' },
    );

    return { data: result };
  }

  @Get('sumup/status')
  @ApiOperation({ summary: 'Get SumUp reader/checkout status' })
  async getSumupStatus(@CurrentDevice() device: Device) {
    const organizationId = requireOrganization(device);
    const readerId = device.settings?.sumupReaderId;
    if (!readerId) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Kein Kartenleser mit diesem Gerät verknüpft',
      });
    }

    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
    });
    if (!organization) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }

    const sumupSettings = (organization.settings as any)?.sumup;
    if (!sumupSettings?.apiKey || !sumupSettings?.merchantCode) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'SumUp ist nicht für diese Organisation konfiguriert',
      });
    }

    const result = await this.sumupApiService.getReaderStatus(
      sumupSettings.apiKey,
      sumupSettings.merchantCode,
      readerId,
    );

    return { data: result };
  }

  @Post('sumup/terminate')
  @ApiOperation({ summary: 'Terminate running SumUp checkout' })
  async terminateSumupCheckout(@CurrentDevice() device: Device) {
    const organizationId = requireOrganization(device);
    const readerId = device.settings?.sumupReaderId;
    if (!readerId) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Kein Kartenleser mit diesem Gerät verknüpft',
      });
    }

    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
    });
    if (!organization) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }

    const sumupSettings = (organization.settings as any)?.sumup;
    if (!sumupSettings?.apiKey || !sumupSettings?.merchantCode) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'SumUp ist nicht für diese Organisation konfiguriert',
      });
    }

    await this.sumupApiService.terminateCheckout(
      sumupSettings.apiKey,
      sumupSettings.merchantCode,
      readerId,
    );

    return { data: { success: true } };
  }

  // Order History & Management

  @Get('orders')
  @ApiOperation({ summary: 'Get all orders for device organization (paginated)' })
  async getAllOrders(
    @CurrentDevice() device: Device,
    @Query('status') status?: string,
    @Query('eventId') eventId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const organizationId = requireOrganization(device);

    const pageNum = Math.max(1, parseInt(page || '1', 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit || '50', 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    const where: any = { organizationId };

    if (status) {
      const validStatuses = Object.values(OrderStatus);
      if (validStatuses.includes(status as OrderStatus)) {
        where.status = status;
      }
    }

    if (eventId) {
      where.eventId = eventId;
    }

    const [orders, total] = await this.orderRepository.findAndCount({
      where,
      relations: ['items'],
      order: { createdAt: 'DESC' },
      skip,
      take: limitNum,
    });

    return {
      data: orders,
      meta: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    };
  }

  @Post('orders/:orderId/cancel')
  @ApiOperation({ summary: 'Cancel an order and restore stock' })
  async cancelOrder(
    @CurrentDevice() device: Device,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() body: { reason?: string },
  ) {
    const organizationId = requireOrganization(device);

    const order = await this.orderRepository.findOne({
      where: { id: orderId, organizationId },
      relations: ['items'],
    });

    if (!order) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Bestellung nicht gefunden',
      });
    }

    if (order.status === OrderStatus.COMPLETED || order.status === OrderStatus.CANCELLED) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Bestellung kann nicht storniert werden (bereits abgeschlossen oder storniert)',
      });
    }

    // Restore stock for items with trackInventory
    for (const item of order.items) {
      if (item.status === OrderItemStatus.CANCELLED) continue;

      const product = await this.productRepository.findOne({
        where: { id: item.productId },
      });

      if (product && product.trackInventory) {
        const quantityBefore = product.stockQuantity;
        product.stockQuantity += item.quantity;
        await this.productRepository.save(product);

        // Create stock movement entry
        const movement = this.stockMovementRepository.create({
          eventId: order.eventId!,
          productId: product.id,
          type: StockMovementType.SALE_CANCELLED,
          quantity: item.quantity,
          quantityBefore,
          quantityAfter: product.stockQuantity,
          referenceType: 'order',
          referenceId: order.id,
          reason: body.reason || 'Order cancelled',
          createdByUserId: null,
        });
        await this.stockMovementRepository.save(movement);

        // Notify POS terminals about stock change
        if (order.eventId) {
          this.gatewayService.notifyProductUpdated(organizationId, order.eventId, {
            id: product.id,
            name: product.name,
            categoryId: product.categoryId,
            price: Number(product.price),
            isAvailable: product.isAvailable,
            isActive: product.isActive,
            stockQuantity: product.stockQuantity,
            trackInventory: product.trackInventory,
          });
        }
      }

      // Cancel the item
      item.status = OrderItemStatus.CANCELLED;
      await this.orderItemRepository.save(item);
    }

    // Update order status
    order.status = OrderStatus.CANCELLED;
    order.cancelledAt = new Date();
    order.cancellationReason = body.reason || null;
    await this.orderRepository.save(order);

    // Gateway notifications
    this.gatewayService.notifyOrderUpdated(organizationId, order.eventId, order.id, {
      status: OrderStatus.CANCELLED,
      cancelledAt: order.cancelledAt,
    });

    if (order.eventId) {
      this.gatewayService.notifyKitchenOrderCancelled(
        organizationId,
        order.id,
        order.orderNumber,
      );
    }

    this.logger.log(`Order ${order.orderNumber} cancelled by device ${device.name}`);

    return { data: order };
  }

  @Post('orders/:orderId/reprint')
  @ApiOperation({ summary: 'Reprint tickets or receipt for an order' })
  async reprintOrder(
    @CurrentDevice() device: Device,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() body: { type?: 'tickets' | 'receipt' },
  ) {
    const organizationId = requireOrganization(device);

    const order = await this.orderRepository.findOne({
      where: { id: orderId, organizationId },
      relations: ['items', 'items.product', 'items.product.category'],
    });

    if (!order) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Bestellung nicht gefunden',
      });
    }

    const printType = body.type || 'tickets';

    if (printType === 'tickets') {
      await this.orderPrintService.handleOrderCreated(organizationId, {
        order,
        orderId: order.id,
        orderNumber: order.orderNumber,
        tableNumber: order.tableNumber,
        total: Number(order.total),
        source: order.source,
      });
    } else {
      // Receipt: find the last payment for this order
      const lastPayment = await this.paymentRepository.findOne({
        where: { orderId: order.id },
        order: { createdAt: 'DESC' },
      });

      if (!lastPayment) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Keine Zahlung für diese Bestellung gefunden',
        });
      }

      await this.orderPrintService.handlePaymentReceived(organizationId, {
        orderId: order.id,
        orderNumber: order.orderNumber,
        paymentId: lastPayment.id,
        amount: Number(lastPayment.amount),
        paymentMethod: lastPayment.paymentMethod,
        isFullyPaid: order.paymentStatus === PaymentStatus.PAID,
        order,
      });
    }

    this.logger.log(`Reprint (${printType}) for order ${order.orderNumber} by device ${device.name}`);

    return { data: { success: true } };
  }

  // Station display endpoints

  @Get('station/items')
  @ApiOperation({ summary: 'Get open items for this device\'s station' })
  async getStationItems(@CurrentDevice() device: Device) {
    const organizationId = requireOrganization(device);
    const stationId = device.settings?.stationId as string | undefined;

    if (!stationId) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Keine Station konfiguriert',
      });
    }

    // Query open items for this station
    const items = await this.orderItemRepository
      .createQueryBuilder('item')
      .leftJoinAndSelect('item.order', 'ord')
      .where('item.productionStationId = :stationId', { stationId })
      .andWhere('item.status NOT IN (:...excludedStatuses)', { excludedStatuses: [OrderItemStatus.CANCELLED, OrderItemStatus.DELIVERED, OrderItemStatus.READY] })
      .andWhere('ord.status NOT IN (:...excludedOrderStatuses)', { excludedOrderStatuses: [OrderStatus.CANCELLED, OrderStatus.COMPLETED] })
      .andWhere('ord.organizationId = :organizationId', { organizationId })
      .orderBy('ord.priority', 'DESC')
      .addOrderBy('ord.createdAt', 'ASC')
      .getMany();

    // Group by order
    const orderMap = new Map<string, { order: any; items: any[] }>();
    for (const item of items) {
      const orderId = item.order.id;
      if (!orderMap.has(orderId)) {
        orderMap.set(orderId, {
          order: {
            id: item.order.id,
            orderNumber: item.order.orderNumber,
            dailyNumber: item.order.dailyNumber,
            tableNumber: item.order.tableNumber,
            customerName: item.order.customerName,
            priority: item.order.priority,
            createdAt: item.order.createdAt,
            fulfillmentType: item.order.fulfillmentType,
            source: item.order.source,
          },
          items: [],
        });
      }
      orderMap.get(orderId)!.items.push({
        id: item.id,
        productName: item.productName,
        categoryName: item.categoryName,
        quantity: item.quantity,
        status: item.status,
        notes: item.notes,
        kitchenNotes: item.kitchenNotes,
        options: item.options,
        createdAt: item.createdAt,
      });
    }

    return { data: Array.from(orderMap.values()) };
  }

  @Post('station/items/:itemId/ready')
  @ApiOperation({ summary: 'Mark a station item as ready' })
  async markStationItemReady(
    @CurrentDevice() device: Device,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    const organizationId = requireOrganization(device);
    const order = await this.ordersService.markItemReadyFromDevice(organizationId, itemId);
    return { data: order };
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

    // Resolve production station: product overrides category
    const productionStationId = product.productionStationId || product.category?.productionStationId || null;

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
      productionStationId,
    });

    await this.orderItemRepository.save(item);

    // Update stock
    if (product.trackInventory) {
      product.stockQuantity -= itemDto.quantity;
      await this.productRepository.save(product);

      // Notify POS terminals about stock change
      const event = await this.eventRepository.findOne({ where: { id: order.eventId! } });
      if (event) {
        this.gatewayService.notifyProductUpdated(event.organizationId, event.id, {
          id: product.id,
          name: product.name,
          categoryId: product.categoryId,
          price: Number(product.price),
          isAvailable: product.isAvailable,
          isActive: product.isActive,
          stockQuantity: product.stockQuantity,
          trackInventory: product.trackInventory,
        });
      }
    }

    return item;
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
      this.logger.error(`Station printing failed for ${station.name}: ${err.message}`);
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
      case PaymentMethod.SUMUP_TERMINAL:
      case PaymentMethod.SUMUP_ONLINE:
        return PaymentProvider.SUMUP;
      default:
        return PaymentProvider.CASH;
    }
  }
}
