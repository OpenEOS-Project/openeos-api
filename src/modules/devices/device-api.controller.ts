import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  Res,
  HttpStatus,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader, ApiQuery } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import {
  Repository,
  In,
  type EntityManager,
  type FindOptionsWhere,
} from 'typeorm';
import { DeviceAuthGuard } from '../../common/guards/device-auth.guard';
import { CurrentDevice } from '../../common/decorators';
import { DevicesService } from './devices.service';
import { CreateDeviceOrderDto, VerifyPinDto } from './dto';
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
import {
  PrinterType,
  PrinterConnectionType,
} from '../../database/entities/printer.entity';
import {
  OrderStatus,
  PaymentStatus,
  OrderSource,
  OrderFulfillmentType,
} from '../../database/entities/order.entity';
import { OrderItemStatus } from '../../database/entities/order-item.entity';
import { StockMovementType } from '../../database/entities/stock-movement.entity';
import {
  PaymentMethod,
  PaymentProvider,
  PaymentTransactionStatus,
} from '../../database/entities/payment.entity';
import { Public } from '../../common/decorators/public.decorator';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { SelectedOptionDto } from '../orders/dto';
import { CreatePaymentDto } from '../payments/dto';
import { SumUpApiService } from '../sumup/sumup-api.service';
import { assertIntegrationEnabled } from '../integrations/integration-catalog';
import { PrintersService } from '../printers/printers.service';
import { GatewayService } from '../gateway/gateway.service';
import { OrderPrintService } from '../print-jobs/order-print.service';
import {
  cashReceivedMetadata,
  orderTaxTotal,
} from '../print-jobs/receipt-tax.util';
import { PrintJobsService } from '../print-jobs/print-jobs.service';
import { OrdersService } from '../orders/orders.service';
import { DiscountVouchersService } from '../discount-vouchers/discount-vouchers.service';
import { PfandTypesService } from '../pfand-types/pfand-types.service';
import { PfandReturnsService } from '../pfand-types/pfand-returns.service';
import { CreatePfandReturnDto } from '../pfand-types/dto';
import { isPfandChargedForFulfillment } from '../../common/utils/pfand-policy';
import { assertTestEventOrderLimitNotReached } from '../../common/utils/test-event-order-limit.util';
import { resolveOrderingMode } from '../../common/utils/ordering-mode';
import {
  PaymentsBatchService,
  type SettledBatch,
} from '../payments/payments-batch.service';
import { saveOrderWithNumbers } from '../orders/order-numbering';
import {
  createDeviceTableLookup,
  isClientRequestConflict,
  resolveDeviceOrderTable,
} from './device-order-table';
import { groupStationItems } from './station-items';

/**
 * Helper to ensure device has an organization.
 * Returns the organizationId as string (non-null).
 */
export function requireOrganization(device: Device): string {
  if (!device.organizationId) {
    throw new ForbiddenException({
      code: ErrorCodes.FORBIDDEN,
      reason: ErrorReasons.DEVICE_NOT_ASSIGNED,
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
    private readonly discountVouchersService: DiscountVouchersService,
    private readonly pfandTypesService: PfandTypesService,
    private readonly pfandReturnsService: PfandReturnsService,
    private readonly configService: ConfigService,
    private readonly paymentsBatchService: PaymentsBatchService,
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
        reason: ErrorReasons.ORGANIZATION_NOT_FOUND,
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

  @Get('discount-vouchers')
  @ApiOperation({
    summary:
      'Get active discount vouchers (Rabatt-Bons) for the device organization',
  })
  async getDiscountVouchers(@CurrentDevice() device: Device) {
    const organizationId = requireOrganization(device);
    const vouchers =
      await this.discountVouchersService.findActiveForOrg(organizationId);
    return { data: vouchers };
  }

  @Get('pfand-types')
  @ApiOperation({
    summary: 'Get active deposit (Pfand) types for the device organization',
  })
  async getPfandTypes(@CurrentDevice() device: Device) {
    const organizationId = requireOrganization(device);
    const pfandTypes =
      await this.pfandTypesService.findActiveForOrg(organizationId);
    return { data: pfandTypes };
  }

  @Post('pfand-returns')
  @ApiOperation({
    summary:
      'Record a deposit payout (Pfand-Rückgabe) and open the cash drawer',
  })
  async createPfandReturn(
    @CurrentDevice() device: Device,
    @Body() dto: CreatePfandReturnDto,
  ) {
    const organizationId = requireOrganization(device);
    const cashDrawerPrinterId = device.settings?.cashDrawerPrinterId as
      | string
      | undefined;

    const pfandReturn = await this.pfandReturnsService.create(
      organizationId,
      dto,
      {
        eventId: dto.eventId ?? null,
        deviceId: device.id,
        cashDrawerPrinterId: cashDrawerPrinterId ?? null,
      },
    );
    return { data: pfandReturn };
  }

  @Get('printers')
  @ApiOperation({
    summary: 'Get printer configurations assigned to this device',
  })
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
    const result = await this.devicesService.verifyPin(
      organizationId,
      verifyPinDto.pin,
    );
    return { data: result };
  }

  @Get('events')
  @ApiOperation({
    summary: 'Get active or test event for device organization (at most one)',
  })
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
      relations: ['pfandType'],
      order: { sortOrder: 'ASC', name: 'ASC' },
    });

    return { data: products };
  }

  // Order endpoints

  @Get('orders/open')
  @ApiOperation({
    summary: 'Get open (unpaid/partly paid) orders of the active/test event',
    description:
      'Offen = unbezahlt/teilbezahlt und weder storniert noch abgeschlossen. Ohne `eventId` gilt das aktive bzw. Test-Event der Organisation. `tableKey` (Tischbezeichnung, groß/klein egal) bzw. `tableId` schränken auf einen Tisch ein, `fulfillmentType` z. B. auf Theke (`counter_pickup`).',
  })
  @ApiQuery({ name: 'eventId', required: false })
  @ApiQuery({ name: 'tableKey', required: false })
  @ApiQuery({ name: 'tableId', required: false })
  @ApiQuery({
    name: 'fulfillmentType',
    required: false,
    enum: OrderFulfillmentType,
  })
  async getOpenOrders(
    @CurrentDevice() device: Device,
    @Query('eventId', new ParseUUIDPipe({ optional: true })) eventId?: string,
    @Query('tableKey') tableKey?: string,
    @Query('tableId', new ParseUUIDPipe({ optional: true })) tableId?: string,
    @Query('fulfillmentType') fulfillmentType?: string,
  ) {
    const organizationId = requireOrganization(device);

    // Frueher kamen hier alle offenen Bestellungen der Organisation ueber
    // alle Events. Jetzt nur das angefragte bzw. das aktive/Test-Event.
    const eventIds = eventId
      ? (
          await this.eventRepository.find({
            where: { id: eventId, organizationId },
            select: { id: true },
          })
        ).map((e) => e.id)
      : (
          await this.eventRepository.find({
            where: {
              organizationId,
              status: In([EventStatus.ACTIVE, EventStatus.TEST]),
            },
            select: { id: true },
          })
        ).map((e) => e.id);
    if (eventIds.length === 0) return { data: [] };

    const query = this.orderRepository
      .createQueryBuilder('o')
      .leftJoinAndSelect('o.items', 'items')
      .where('o.organizationId = :organizationId', { organizationId })
      .andWhere('o.eventId IN (:...eventIds)', { eventIds })
      .andWhere('o.paymentStatus IN (:...openPayment)', {
        openPayment: [PaymentStatus.UNPAID, PaymentStatus.PARTLY_PAID],
      })
      .andWhere('o.status NOT IN (:...closedStatus)', {
        closedStatus: [OrderStatus.CANCELLED, OrderStatus.COMPLETED],
      });

    const key = tableKey?.trim();
    if (tableId) {
      // Tisch per ID; Bestellungen ohne table_id (Altdaten, freie Nummer)
      // gehoeren dazu, wenn ihre Nummer der Tischbezeichnung entspricht.
      query.andWhere(
        `(o.tableId = :tableId OR (o.tableId IS NULL AND upper(btrim(o.tableNumber)) = (
           SELECT upper(t.label) FROM dining_tables t
            WHERE t.id = :tableId AND t.organization_id = :organizationId
         )))`,
        { tableId },
      );
    }
    if (key) {
      query.andWhere('upper(btrim(o.tableNumber)) = upper(:tableKey)', {
        tableKey: key,
      });
    }
    if (
      fulfillmentType === OrderFulfillmentType.COUNTER_PICKUP ||
      fulfillmentType === OrderFulfillmentType.TABLE_SERVICE
    ) {
      query.andWhere('o.fulfillmentType = :fulfillmentType', {
        fulfillmentType,
      });
    }

    const orders = await query
      .orderBy('o.createdAt', 'DESC')
      .addOrderBy('items.sortOrder', 'ASC')
      .getMany();

    return { data: orders };
  }

  @Post('orders')
  @ApiOperation({
    summary: 'Create a new order from device',
    description:
      'Tischbetrieb je Gerät und Veranstaltung (Spezifikation §2.3). Mit `clientRequestId` idempotent: eine Wiederholung liefert die bestehende Bestellung mit HTTP 200, ohne erneuten Küchenbon. Mit `payment` werden Bestellung und Zahlung in einer Transaktion gebucht; im Kassiermodus `immediate` ist das Pflicht (sonst 400 ORDER_PAYMENT_REQUIRED) — Küchenbon und Stationen bekommen die Bestellung dann erst nach der Zahlung.',
  })
  async createOrder(
    @CurrentDevice() device: Device,
    @Body() createDto: CreateDeviceOrderDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const organizationId = requireOrganization(device);
    const clientRequestId = createDto.clientRequestId ?? null;

    // Wiederholung derselben Anlage: bestehende Bestellung zurueckgeben,
    // nichts drucken, nichts melden.
    if (clientRequestId) {
      const existing = await this.findOrderByClientRequest(
        organizationId,
        clientRequestId,
      );
      if (existing) {
        response.status(HttpStatus.OK);
        return { data: await this.settleExisting(existing, createDto, device) };
      }
    }

    // Validate event
    let event: Event | null = null;
    if (createDto.eventId) {
      event = await this.eventRepository.findOne({
        where: { id: createDto.eventId, organizationId },
      });

      if (!event) {
        throw new NotFoundException({
          code: ErrorCodes.NOT_FOUND,
          reason: ErrorReasons.EVENT_NOT_FOUND,
          message: 'Event nicht gefunden',
        });
      }

      if (
        event.status !== EventStatus.ACTIVE &&
        event.status !== EventStatus.TEST
      ) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.EVENT_NOT_ACTIVE,
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

    // Bestellung, Positionen, Bestand und Summen in einer Transaktion:
    // scheitert eine Position (Bestand, Produkt), bleibt keine leere
    // Bestellung zurueck, die eine Wiederholung dann ausliefern wuerde.
    let created: {
      order: Order;
      stockChanges: Product[];
      settled: SettledBatch | null;
    };
    try {
      created = await this.orderRepository.manager.transaction(
        async (manager) => {
          // Match the POS, which treats an unset serviceMode as table
          // service (Bedienung, default). Counter devices and events without
          // tables never carry a table number (otherwise a stray table
          // number shows up on the kitchen ticket of a counter order).
          const table = await resolveDeviceOrderTable(
            {
              serviceMode: device.settings?.serviceMode,
              eventTables: event?.settings?.tables,
              fulfillmentType: createDto.fulfillmentType,
              tableId: createDto.tableId,
              tableNumber: createDto.tableNumber,
            },
            createDeviceTableLookup(manager, organizationId),
          );

          // Order number and daily number are allocated together with the
          // insert (savepoint inside this transaction).
          const order = await saveOrderWithNumbers(
            manager.getRepository(Order),
            { organizationId, eventId: createDto.eventId || null },
            {
              tableNumber: table.tableNumber,
              tableId: table.tableId,
              customerName: createDto.customerName || null,
              customerPhone: createDto.customerPhone || null,
              notes: createDto.notes || null,
              priority: createDto.priority || undefined,
              source: createDto.source || OrderSource.POS,
              fulfillmentType: table.fulfillmentType,
              discountAmount: createDto.discountAmount || 0,
              discountReason: createDto.discountReason || null,
              tipAmount: createDto.tipAmount || 0,
              createdByDeviceId: device.id,
              clientRequestId,
              status: OrderStatus.OPEN,
              paymentStatus: PaymentStatus.UNPAID,
            },
          );

          // Resolve the Pfand policy for this order's fulfillment type
          // (e.g. no deposit for table service).
          const organization = await manager.findOne(Organization, {
            where: { id: organizationId },
          });
          const chargePfand = isPfandChargedForFulfillment(
            order.fulfillmentType,
            organization?.settings,
          );

          const stockChanges: Product[] = [];
          if (createDto.items && createDto.items.length > 0) {
            for (const itemDto of createDto.items) {
              await this.addItemToOrder(
                manager,
                order,
                itemDto,
                chargePfand,
                stockChanges,
              );
            }
            await this.recalculateOrderTotals(
              manager,
              order.id,
              organization?.settings?.vatExempt,
            );
          }

          const completeOrder = await manager.findOne(Order, {
            where: { id: order.id },
            relations: ['items'],
          });
          if (!completeOrder) {
            throw new NotFoundException({
              code: ErrorCodes.NOT_FOUND,
              reason: ErrorReasons.ORDER_NOT_FOUND,
              message: 'Bestellung nicht gefunden',
            });
          }

          // Zahlung gleich mit: Bestellung und Zahlung gelingen zusammen
          // oder gar nicht. Die neue Bestellung ist die letzte (Trinkgeld,
          // erhaltenes Bargeld).
          if (createDto.payment) {
            const { orderIds: others = [], ...payment } = createDto.payment;
            const settled = await this.paymentsBatchService.settle(
              manager,
              organizationId,
              device.id,
              {
                ...payment,
                orderIds: [
                  ...others.filter((id) => id !== completeOrder.id),
                  completeOrder.id,
                ],
              },
            );
            const paidOrder =
              settled.orders.find((o) => o.id === completeOrder.id) ??
              completeOrder;
            return { order: paidOrder, stockChanges, settled };
          }

          // A fully-discounted order (total 0) has nothing to pay. Mark it
          // paid right away so the POS reaches the success screen without
          // sending a 0-amount payment (which the payment endpoint rejects).
          if (Number(completeOrder.total) <= 0) {
            completeOrder.paymentStatus = PaymentStatus.PAID;
            completeOrder.paidAmount = 0;
            await manager.save(completeOrder);
            return { order: completeOrder, stockChanges, settled: null };
          }

          // „Sofort kassieren“: keine unbezahlte Bestellung aus der Kasse —
          // sonst landet sie in Küche und Stationen, ohne dass jemand
          // bezahlt hat (F8). Die Transaktion rollt alles zurück.
          if (
            resolveOrderingMode(event?.settings, organization?.settings) ===
            'immediate'
          ) {
            throw new BadRequestException({
              code: ErrorCodes.VALIDATION_ERROR,
              reason: ErrorReasons.ORDER_PAYMENT_REQUIRED,
              message:
                'Im Kassiermodus „Sofort kassieren“ entsteht eine Bestellung erst mit ihrer Zahlung. Lade die Kasse neu und kassiere erneut.',
            });
          }

          return { order: completeOrder, stockChanges, settled: null };
        },
      );
    } catch (error) {
      // Gleichzeitige Wiederholung: die andere Anfrage war schneller.
      if (clientRequestId && isClientRequestConflict(error)) {
        const existing = await this.findOrderByClientRequest(
          organizationId,
          clientRequestId,
        );
        if (existing) {
          response.status(HttpStatus.OK);
          return {
            data: await this.settleExisting(existing, createDto, device),
          };
        }
      }
      throw error;
    }

    const completeOrder = created.order;

    // Notify POS terminals about stock changes (after commit).
    if (completeOrder.eventId) {
      for (const product of created.stockChanges) {
        this.gatewayService.notifyProductUpdated(
          organizationId,
          completeOrder.eventId,
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

    this.logger.log(
      `Device order created: ${completeOrder.orderNumber} (${completeOrder.id}) by device ${device.name}`,
    );

    // Print station tickets and notify admin order list
    if (completeOrder.items && completeOrder.items.length > 0) {
      // Kitchen/station ticket printing is handled centrally by
      // OrderPrintService.handleOrderCreated below — it is template-driven and
      // respects the org's kitchenTicketPrinting settings (per_station splits
      // by Produktionsstandort). The legacy direct printToStation path was
      // removed: it bypassed the template and emitted a malformed duplicate
      // ticket (camelCase payload, no template → "half receipt, no products").

      // Notify admin order list
      this.gatewayService.notifyOrderCreated(
        organizationId,
        completeOrder.eventId,
        {
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
        },
      );

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

    // Zahlungsereignisse und Kassenbon nach dem Küchenbon.
    if (created.settled) {
      this.paymentsBatchService.afterCommit(organizationId, created.settled);
    }

    return { data: completeOrder };
  }

  /**
   * Wiederholung einer Anlage (gleiche `clientRequestId`). Kam die erste
   * Anfrage ohne Zahlung an (ältere Kasse) und bringt die Wiederholung
   * eine mit, wird die Bestellung jetzt bezahlt — sonst bleibt alles, wie
   * es ist.
   */
  private async settleExisting(
    existing: Order,
    createDto: CreateDeviceOrderDto,
    device: Device,
  ): Promise<Order> {
    const open =
      existing.paymentStatus === PaymentStatus.UNPAID ||
      existing.paymentStatus === PaymentStatus.PARTLY_PAID;
    if (!createDto.payment || !open) return existing;

    const organizationId = requireOrganization(device);
    const { orderIds: others = [], ...payment } = createDto.payment;
    const settled = await this.orderRepository.manager.transaction((manager) =>
      this.paymentsBatchService.settle(manager, organizationId, device.id, {
        ...payment,
        orderIds: [...others.filter((id) => id !== existing.id), existing.id],
      }),
    );
    this.paymentsBatchService.afterCommit(organizationId, settled);
    return settled.orders.find((o) => o.id === existing.id) ?? existing;
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
    if (createDto.amount > remainingAmount + 0.01) {
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
      providerTransactionId: null,
      status: PaymentTransactionStatus.CAPTURED,
      metadata: cashReceivedMetadata(
        createDto.paymentMethod,
        createDto.amount,
        createDto.amountReceived,
      ),
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
      const activeItems = order.items.filter(
        (i) => i.status !== OrderItemStatus.CANCELLED,
      );
      const allWorkflowDone = activeItems.every(
        (i) => !i.productionStationId || i.status === OrderItemStatus.DELIVERED,
      );

      if (allWorkflowDone) {
        order.status = OrderStatus.COMPLETED;
        order.completedAt = new Date();
        await this.orderRepository.save(order);
      }
    }

    this.logger.log(
      `Device payment created: ${payment.id} for order ${order.orderNumber}`,
    );

    // NB: the cash drawer is opened by the POS as soon as the cash payment
    // starts (POST /device-api/cash-drawer/open when the cash modal opens), so
    // the cashier can make change while entering the amount. We deliberately do
    // NOT re-open it here on confirm — that would pop the drawer again after
    // they already closed it.

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
        amountReceived: payment.metadata?.amountReceived,
      })
      .catch((err) =>
        this.logger.error(
          `Auto-receipt on payment ${payment.id} failed: ${(err as Error).message}`,
        ),
      );

    return { data: payment };
  }

  @Post('payments/split')
  @ApiOperation({
    summary: 'Create a split payment for specific items from device',
  })
  async createSplitPayment(
    @CurrentDevice() device: Device,
    @Body()
    createDto: {
      orderId: string;
      amount: number;
      paymentMethod: PaymentMethod;
      items: Array<{ orderItemId: string; quantity: number }>;
      amountReceived?: number;
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

    // Validate items and calculate expected amount
    let expectedAmount = 0;
    const itemsToUpdate: { item: OrderItem; payQty: number }[] = [];

    for (const itemDto of createDto.items) {
      const item = order.items.find((i) => i.id === itemDto.orderItemId);
      if (!item) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.ORDER_ITEM_NOT_FOUND,
          message: `Artikel nicht gefunden: ${itemDto.orderItemId}`,
        });
      }

      const unpaidQty = item.quantity - (item.paidQuantity || 0);
      if (itemDto.quantity > unpaidQty) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.INSUFFICIENT_UNPAID_QUANTITY,
          message: `Nicht genug unbezahlte Menge für ${item.productName}`,
          params: { product: item.productName },
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
        reason: ErrorReasons.PAYMENT_AMOUNT_MISMATCH,
        message: `Betrag stimmt nicht überein. Erwartet: ${expectedAmount}, Erhalten: ${createDto.amount}`,
        params: { expected: expectedAmount, received: createDto.amount },
      });
    }

    const provider = this.getProviderForMethod(createDto.paymentMethod);
    await this.assertProviderEnabled(organizationId, provider);

    // Create payment
    const payment = this.paymentRepository.create({
      orderId: createDto.orderId,
      amount: createDto.amount,
      paymentMethod: createDto.paymentMethod,
      paymentProvider: provider,
      providerTransactionId: null,
      status: PaymentTransactionStatus.CAPTURED,
      metadata: {
        splitItems: createDto.items,
        ...cashReceivedMetadata(
          createDto.paymentMethod,
          createDto.amount,
          createDto.amountReceived,
        ),
      },
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
      const activeItems = order.items.filter(
        (i) => i.status !== OrderItemStatus.CANCELLED,
      );
      const allWorkflowDone = activeItems.every(
        (i) => !i.productionStationId || i.status === OrderItemStatus.DELIVERED,
      );

      if (allWorkflowDone) {
        order.status = OrderStatus.COMPLETED;
        order.completedAt = new Date();
        await this.orderRepository.save(order);
      }
    }

    this.logger.log(
      `Device split payment created: ${payment.id} for order ${order.orderNumber}`,
    );

    // Auto-open cash drawer on cash payment
    if (createDto.paymentMethod === PaymentMethod.CASH) {
      try {
        const cashDrawerPrinterId = device.settings?.cashDrawerPrinterId as
          | string
          | undefined;
        if (cashDrawerPrinterId) {
          this.gatewayService.sendOpenCashDrawer(
            organizationId,
            cashDrawerPrinterId,
          );
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
    const cashDrawerPrinterId = device.settings?.cashDrawerPrinterId as
      | string
      | undefined;

    if (!cashDrawerPrinterId) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.CASH_DRAWER_NOT_CONFIGURED,
        message: 'Keine Kassenschublade konfiguriert',
      });
    }

    const printer = await this.printerRepository.findOne({
      where: { id: cashDrawerPrinterId, organizationId },
    });

    if (!printer) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.PRINTER_NOT_FOUND,
        message: 'Drucker nicht gefunden',
      });
    }

    if (!printer.hasCashDrawer) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.PRINTER_HAS_NO_CASH_DRAWER,
        message: 'Drucker hat keine Kassenschublade',
      });
    }

    if (!printer.isActive) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.PRINTER_INACTIVE,
        message: 'Drucker ist nicht aktiv',
      });
    }

    this.gatewayService.sendOpenCashDrawer(organizationId, cashDrawerPrinterId);

    return { data: { success: true } };
  }

  // SumUp endpoints
  //
  // Alle drei pruefen, ob SumUp fuer die Organisation eingeschaltet ist.
  // Die Kasse blendet die Kartenzahlung dann zwar aus, aber eine Kasse mit
  // altem Stand oder ein direkter Aufruf soll trotzdem nichts ausloesen.

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
        reason: ErrorReasons.CARD_READER_NOT_LINKED,
        message: 'Kein Kartenleser mit diesem Gerät verknüpft',
      });
    }

    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
    });
    if (!organization) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.ORGANIZATION_NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }

    assertIntegrationEnabled(organization.settings, 'sumup');
    const sumupSettings = organization.settings?.sumup;
    if (!sumupSettings?.apiKey || !sumupSettings?.merchantCode) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.SUMUP_NOT_CONFIGURED,
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
  async getSumupStatus(
    @CurrentDevice() device: Device,
    @Query('clientTransactionId') clientTransactionId?: string,
  ) {
    const organizationId = requireOrganization(device);
    const readerId = device.settings?.sumupReaderId;
    if (!readerId) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.CARD_READER_NOT_LINKED,
        message: 'Kein Kartenleser mit diesem Gerät verknüpft',
      });
    }

    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
    });
    if (!organization) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.ORGANIZATION_NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }

    assertIntegrationEnabled(organization.settings, 'sumup');
    const sumupSettings = organization.settings?.sumup;
    if (!sumupSettings?.apiKey || !sumupSettings?.merchantCode) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.SUMUP_NOT_CONFIGURED,
        message: 'SumUp ist nicht für diese Organisation konfiguriert',
      });
    }

    // Preferred: resolve the actual payment outcome via the transaction the
    // checkout created. The reader status (below) only reports device
    // telemetry, never SUCCESSFUL/FAILED, so the POS could never detect success.
    if (clientTransactionId) {
      const { status } = await this.sumupApiService.getTransactionStatus(
        sumupSettings.apiKey,
        sumupSettings.merchantCode,
        clientTransactionId,
      );
      return { data: { checkout: { status } } };
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
        reason: ErrorReasons.CARD_READER_NOT_LINKED,
        message: 'Kein Kartenleser mit diesem Gerät verknüpft',
      });
    }

    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
    });
    if (!organization) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.ORGANIZATION_NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }

    assertIntegrationEnabled(organization.settings, 'sumup');
    const sumupSettings = organization.settings?.sumup;
    if (!sumupSettings?.apiKey || !sumupSettings?.merchantCode) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.SUMUP_NOT_CONFIGURED,
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
  @ApiOperation({
    summary: 'Get all orders for device organization (paginated)',
  })
  async getAllOrders(
    @CurrentDevice() device: Device,
    @Query('status') status?: string,
    @Query('eventId') eventId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const organizationId = requireOrganization(device);

    const pageNum = Math.max(1, parseInt(page || '1', 10) || 1);
    const limitNum = Math.min(
      100,
      Math.max(1, parseInt(limit || '50', 10) || 50),
    );
    const skip = (pageNum - 1) * limitNum;

    const where: FindOptionsWhere<Order> = { organizationId };

    if (status) {
      const validStatuses = Object.values(OrderStatus);
      if (validStatuses.includes(status as OrderStatus)) {
        where.status = status as OrderStatus;
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
        reason: ErrorReasons.ORDER_NOT_FOUND,
        message: 'Bestellung nicht gefunden',
      });
    }

    if (
      order.status === OrderStatus.COMPLETED ||
      order.status === OrderStatus.CANCELLED
    ) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.ORDER_CANNOT_BE_CANCELLED,
        message:
          'Bestellung kann nicht storniert werden (bereits abgeschlossen oder storniert)',
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
          this.gatewayService.notifyProductUpdated(
            organizationId,
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
    this.gatewayService.notifyOrderUpdated(
      organizationId,
      order.eventId,
      order.id,
      {
        status: OrderStatus.CANCELLED,
        cancelledAt: order.cancelledAt,
      },
    );

    if (order.eventId) {
      this.gatewayService.notifyKitchenOrderCancelled(
        organizationId,
        order.id,
        order.orderNumber,
      );
    }

    this.logger.log(
      `Order ${order.orderNumber} cancelled by device ${device.name}`,
    );

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
        reason: ErrorReasons.ORDER_NOT_FOUND,
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
          reason: ErrorReasons.PAYMENT_NOT_FOUND,
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
        amountReceived: lastPayment.metadata?.amountReceived,
      });
    }

    this.logger.log(
      `Reprint (${printType}) for order ${order.orderNumber} by device ${device.name}`,
    );

    return { data: { success: true } };
  }

  // Station display endpoints

  @Get('station/items')
  @ApiOperation({ summary: "Get open items for this device's station" })
  async getStationItems(@CurrentDevice() device: Device) {
    const organizationId = requireOrganization(device);
    const stationId = device.settings?.stationId as string | undefined;

    if (!stationId) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.STATION_NOT_CONFIGURED,
        message: 'Keine Station konfiguriert',
      });
    }

    // Query open items for this station
    const items = await this.orderItemRepository
      .createQueryBuilder('item')
      .leftJoinAndSelect('item.order', 'ord')
      .where('item.productionStationId = :stationId', { stationId })
      .andWhere('item.status NOT IN (:...excludedStatuses)', {
        excludedStatuses: [
          OrderItemStatus.CANCELLED,
          OrderItemStatus.DELIVERED,
          OrderItemStatus.READY,
        ],
      })
      .andWhere('ord.status NOT IN (:...excludedOrderStatuses)', {
        excludedOrderStatuses: [OrderStatus.CANCELLED, OrderStatus.COMPLETED],
      })
      .andWhere('ord.organizationId = :organizationId', { organizationId })
      .orderBy('ord.priority', 'DESC')
      .addOrderBy('ord.createdAt', 'ASC')
      .getMany();

    return { data: groupStationItems(items) };
  }

  @Post('station/items/:itemId/ready')
  @ApiOperation({ summary: 'Mark a station item as ready' })
  async markStationItemReady(
    @CurrentDevice() device: Device,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    const organizationId = requireOrganization(device);
    const order = await this.ordersService.markItemReadyFromDevice(
      organizationId,
      itemId,
    );
    return { data: order };
  }

  // Private helper methods

  private findOrderByClientRequest(
    organizationId: string,
    clientRequestId: string,
  ): Promise<Order | null> {
    return this.orderRepository.findOne({
      where: { organizationId, clientRequestId },
      relations: ['items'],
    });
  }

  private async addItemToOrder(
    manager: EntityManager,
    order: Order,
    itemDto: {
      productId: string;
      quantity: number;
      notes?: string;
      kitchenNotes?: string;
      selectedOptions?: SelectedOptionDto[];
      isRefill?: boolean;
    },
    chargePfand: boolean,
    stockChanges: Product[],
  ): Promise<OrderItem> {
    const productRepository = manager.getRepository(Product);
    const orderItemRepository = manager.getRepository(OrderItem);

    const product = await productRepository.findOne({
      where: { id: itemDto.productId, eventId: order.eventId! },
      relations: ['category', 'pfandType'],
    });

    if (!product) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.PRODUCT_NOT_FOUND,
        message: 'Produkt nicht gefunden',
      });
    }

    if (!product.isActive || !product.isAvailable) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.PRODUCT_UNAVAILABLE,
        message: `Produkt ${product.name} ist nicht verfügbar`,
        params: { product: product.name },
      });
    }

    // Check stock
    if (product.trackInventory && product.stockQuantity < itemDto.quantity) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.INSUFFICIENT_STOCK_FOR_PRODUCT,
        message: `Nicht genügend Bestand für ${product.name}`,
        params: { product: product.name },
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
    const existingItems = await orderItemRepository.count({
      where: { orderId: order.id },
    });

    // Resolve production station: product overrides category
    const productionStationId =
      product.productionStationId ||
      product.category?.productionStationId ||
      null;

    const item = orderItemRepository.create({
      orderId: order.id,
      productId: product.id,
      categoryId: product.categoryId,
      productName: product.name,
      categoryName: product.category?.name || '',
      quantity: itemDto.quantity,
      unitPrice,
      optionsPrice,
      // Satz des Produkts festhalten; daraus rechnen Bon und taxTotal.
      taxRate: Number(product.taxRate) || 0,
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

    await orderItemRepository.save(item);

    // Update stock; POS terminals are notified after commit.
    if (product.trackInventory) {
      product.stockQuantity -= itemDto.quantity;
      await productRepository.save(product);
      const index = stockChanges.findIndex((p) => p.id === product.id);
      if (index >= 0) stockChanges[index] = product;
      else stockChanges.push(product);
    }

    return item;
  }

  private async recalculateOrderTotals(
    manager: EntityManager,
    orderId: string,
    vatExempt: boolean | undefined,
  ): Promise<void> {
    const order = await manager.findOne(Order, {
      where: { id: orderId },
      relations: ['items'],
    });

    if (!order) return;

    let subtotal = 0;
    let pfandTotal = 0;

    for (const item of order.items) {
      if (item.status !== OrderItemStatus.CANCELLED) {
        subtotal += Number(item.totalPrice);
        pfandTotal += Number(item.depositAmount || 0) * item.quantity;
      }
    }

    order.subtotal = subtotal;
    order.pfandTotal = pfandTotal;

    // Cap the discount at the subtotal so the order total can never go negative —
    // any voucher value beyond the order amount is forfeited (not paid out).
    // Pfand (deposit) is added on top and is tax-free (not part of subtotal/taxTotal).
    const effectiveDiscount = Math.min(
      Number(order.discountAmount || 0),
      subtotal,
    );
    order.discountAmount = effectiveDiscount;
    order.total =
      subtotal - effectiveDiscount + Number(order.tipAmount || 0) + pfandTotal;

    // Wie in OrdersService.recalculateOrderTotals: enthaltene Steuer,
    // dieselbe Rechnung wie auf dem Bon.
    order.taxTotal = orderTaxTotal(order.items, effectiveDiscount, vatExempt);

    await manager.save(order);
  }

  private async updateOrderPaymentStatus(order: Order): Promise<void> {
    // Compare in integer cents — summing decimal payments in floating point
    // can land a fully-paid order at e.g. 41.0999999 < 41.10, which would
    // mark it "partly paid" even though it was settled in full.
    const paidCents = Math.round(Number(order.paidAmount) * 100);
    const totalCents = Math.round(Number(order.total) * 100);

    if (paidCents >= totalCents) {
      order.paymentStatus = PaymentStatus.PAID;
    } else if (paidCents > 0) {
      order.paymentStatus = PaymentStatus.PARTLY_PAID;
    } else {
      order.paymentStatus = PaymentStatus.UNPAID;
    }

    await this.orderRepository.save(order);
  }

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
}
