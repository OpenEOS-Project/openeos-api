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
  GoneException,
  Logger,
  Optional,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader, ApiQuery } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { Repository, In, type EntityManager } from 'typeorm';
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
import { DeviceType } from '../../database/entities/device.entity';
import {
  OrderStatus,
  PaymentStatus,
  OrderSource,
  OrderFulfillmentType,
} from '../../database/entities/order.entity';
import { OrderItemStatus } from '../../database/entities/order-item.entity';
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
import { TseSigningService } from '../tse/tse-signing.service';
import { OrganizationViewService } from '../organizations/organization-view.service';
import type { TseReceiptView } from '../tse/tse-view';
import {
  assertCashAllowed,
  assertPaymentsAllowed,
  handOverOnCompletion,
  isOrdersOnly,
  OPERATING_MODE_SELECT,
  shouldAutoCompleteOrderOnly,
} from '../../common/utils/operating-mode.util';
import { PrintersService } from '../printers/printers.service';
import { PrinterAgentsService } from '../printers/printer-agents.service';
import { ReportDiscoveredPrintersDto } from '../printers/dto';
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
import { CreatePfandReturnDto, PrintPfandReturnDto } from '../pfand-types/dto';
import {
  isPfandChargedForFulfillment,
  pfandVatRate,
} from '../../common/utils/pfand-policy';
import {
  assertSumUpAllowedInMode,
  currentEventStatus,
} from '../../common/utils/sumup-test-mode.util';
import { resolveOrderingMode } from '../../common/utils/ordering-mode';
import {
  PaymentsBatchService,
  type SettledBatch,
} from '../payments/payments-batch.service';
import { saveOrderWithNumbers } from '../orders/order-numbering';
import { EventPhaseService } from '../events/event-phase.service';
import { closedWithoutPaymentError } from '../orders/close-without-payment';
import {
  createDeviceTableLookup,
  isClientRequestConflict,
  resolveDeviceOrderTable,
} from './device-order-table';
import { groupStationItems } from './station-items';
import { RefundsService } from '../refunds/refunds.service';
import {
  OrderHistoryService,
  parseHistoryFilters,
} from '../refunds/order-history.service';
import {
  CancelItemsDto,
  CancelOrderWithActorDto,
  CreateRefundDto,
  ReprintDto,
} from '../refunds/dto/refund.dto';
import { agentTemplateMap } from '../print-jobs/builtin-templates';
import { CurrentOperator, WithOperator } from '../waiters/waiter-session.guard';
import {
  attributionOf,
  type Attribution,
  type Operator,
} from '../waiters/waiter-operator';
import { assertOperatorMay } from '../waiters/waiter-sessions.service';

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
    private readonly refundsService: RefundsService,
    private readonly orderHistoryService: OrderHistoryService,
    private readonly printerAgentsService: PrinterAgentsService,
    @Optional()
    private readonly tseSigning?: TseSigningService,
    // Optional mit Rueckfall: ohne TSE-Modul (Tests) bleibt `tse` null.
    @Optional()
    private readonly organizationView: OrganizationViewService = new OrganizationViewService(),
    // Optional mit Rueckfall fuer von Hand gebaute Tests (Standardwerte).
    @Optional()
    private readonly eventPhaseService?: EventPhaseService,
  ) {}

  private get eventPhase(): EventPhaseService {
    return (
      this.eventPhaseService ??
      EventPhaseService.standalone(
        this.organizationRepository,
        this.orderRepository,
        this.configService,
      )
    );
  }

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
        // Abgeleitete Felder wie jede Organisations-Antwort
        // (OrganizationViewService): country, operatingMode,
        // operatingModeLegacy, operatingModeSince, tseActive, cashAllowed,
        // pricesVisible, tse. Die Kasse richtet Preise, Zahlarten und
        // Abschluss danach; der Server prueft jede Zahlung trotzdem selbst.
        ...(await this.organizationView.derived(organization)),
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
    // „Nur Bons“: keine Rabatte und Gutscheine.
    if (await this.isOrdersOnlyOrg(organizationId)) return { data: [] };
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
    // „Nur Bons“: kein Pfand.
    if (await this.isOrdersOnlyOrg(organizationId)) return { data: [] };
    const pfandTypes =
      await this.pfandTypesService.findActiveForOrg(organizationId);
    return { data: pfandTypes };
  }

  @Post('pfand-returns')
  @ApiOperation({
    summary:
      'Record a deposit payout (Pfand-Rückgabe) and open the cash drawer',
  })
  @WithOperator()
  async createPfandReturn(
    @CurrentDevice() device: Device,
    @Body() dto: CreatePfandReturnDto,
    @CurrentOperator() operator: Operator | null,
  ) {
    const organizationId = requireOrganization(device);
    const cashDrawerPrinterId = device.settings?.cashDrawerPrinterId as
      | string
      | undefined;

    // Die Pruefung auf den bargeldlosen Modus steckt im Dienst: die
    // Pfand-Rueckgabe ist eine reine Barauszahlung.
    const pfandReturn = await this.pfandReturnsService.create(
      organizationId,
      dto,
      {
        eventId: dto.eventId ?? null,
        deviceId: device.id,
        deviceName: device.name,
        cashDrawerPrinterId: cashDrawerPrinterId ?? null,
        userId: operator?.userId ?? null,
        waiterId: operator?.waiterId ?? null,
        actorName: operator?.name ?? null,
      },
    );
    return { data: pfandReturn };
  }

  @Post('pfand-returns/:pfandReturnId/print')
  @ApiOperation({
    summary: 'Beleg einer Pfand-Rückgabe drucken (auf Wunsch oder Nachdruck)',
    description:
      'Druckt den Beleg „Pfandrückgabe“ einer gespeicherten Auszahlung auf dem Bon-Drucker dieser Kasse: gespeicherte Beträge, MwSt je Satz und TSE-Daten, keine neue TSE-Transaktion. `reprint: true` druckt den Vermerk „NACHDRUCK“.',
  })
  async printPfandReturn(
    @CurrentDevice() device: Device,
    @Param('pfandReturnId', ParseUUIDPipe) pfandReturnId: string,
    @Body() body: PrintPfandReturnDto,
  ) {
    const organizationId = requireOrganization(device);
    const result = await this.pfandReturnsService.printReceipt(
      organizationId,
      pfandReturnId,
      {
        deviceId: device.id,
        deviceName: device.name,
        reprint: body?.reprint === true,
      },
    );
    return { data: { success: true, printed: result.printed } };
  }

  @Get('printers')
  @ApiOperation({
    summary: 'Übernommene Drucker dieses Agents',
    description:
      'Nur übernommene (adoptierte) oder manuell angelegte Drucker — der Agent druckt ausschließlich auf diese. Neu laden bei `printerConfigUpdate`.',
  })
  async getPrinters(@CurrentDevice() device: Device) {
    const printers = await this.printersService.findByDeviceId(device.id);

    return {
      data: {
        printers: printers.map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          fingerprint: p.fingerprint,
          connectionType: p.connectionType,
          connectionConfig: p.connectionConfig,
          paperWidth: p.paperWidth,
          hasCashDrawer: p.hasCashDrawer,
          isActive: p.isActive,
        })),
      },
    };
  }

  @Post('printers/discovered')
  @ApiOperation({
    summary: 'Gefundene Drucker melden',
    description:
      'Upsert nach (deviceId, fingerprint), lastSeenAt = jetzt. Bei `full: true` (kompletter Scan) werden nicht gemeldete Einträge nicht gelöscht, nur ihr lastSeenAt bleibt alt.',
  })
  async reportDiscoveredPrinters(
    @CurrentDevice() device: Device,
    @Body() body: ReportDiscoveredPrintersDto,
  ) {
    const organizationId = requireOrganization(device);
    if (device.type !== DeviceType.PRINTER_AGENT) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.DEVICE_NOT_PRINTER_AGENT,
        message: 'Gerät ist kein Drucker-Agent',
      });
    }
    const printers = await this.printerAgentsService.reportDiscovered(
      device.id,
      organizationId,
      body,
    );
    return { data: { printers } };
  }

  @Post('printers/sync')
  @ApiOperation({
    summary: 'Entfernt — 410 Gone',
    description:
      'Die Druckerliste kommt nicht mehr aus der YAML des Agents. Drucker werden in der Web-App übernommen; der Agent liest sie über GET /device-api/printers.',
    deprecated: true,
  })
  syncPrinters() {
    throw new GoneException({
      code: ErrorCodes.PRINTER_SYNC_REMOVED,
      reason: ErrorReasons.PRINTER_SYNC_REMOVED,
      message:
        'Die Druckerliste wird nicht mehr vom Agenten gepflegt — bitte den Agenten aktualisieren',
    });
  }

  @Get('templates')
  @ApiOperation({ summary: 'Get print templates for this device' })
  async getTemplates(@CurrentDevice() device: Device) {
    const organizationId = requireOrganization(device);

    const templates = await this.printTemplateRepository.find({
      where: { organizationId },
    });

    const templateMap = agentTemplateMap(templates);

    return {
      data: {
        templates: templateMap,
      },
    };
  }

  @Post('verify-pin')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'PIN prüfen (Alias von POST /device-api/waiter-session)',
    description:
      'Rückwärtskompatibel: meldet die Bedienung bzw. das Mitglied an wie `POST /device-api/waiter-session` und liefert zusätzlich `userId`, `firstName`, `lastName`, `role`. Neu: `token` für den Header `X-Waiter-Session`. Fehler wie dort (403 PIN_INVALID, 429 PIN_LOCKED).',
  })
  async verifyPin(
    @CurrentDevice() device: Device,
    @Body() verifyPinDto: VerifyPinDto,
  ) {
    requireOrganization(device);
    const result = await this.devicesService.verifyPin(
      device,
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

    // Phase (Testbetrieb bis …, beendet) fuer den Hinweis in der Kasse.
    return { data: await this.eventPhase.decorateMany(events) };
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

    return { data: await this.eventPhase.decorate(event) };
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
      })
      // „Ohne Zahlung abgeschlossen“: bar ausserhalb kassiert, erledigt.
      .andWhere('o.closedWithoutPaymentAt IS NULL');

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
  @WithOperator()
  async createOrder(
    @CurrentDevice() device: Device,
    @Body() createDto: CreateDeviceOrderDto,
    @Res({ passthrough: true }) response: Response,
    @CurrentOperator() operator: Operator | null = null,
  ) {
    const organizationId = requireOrganization(device);
    const clientRequestId = createDto.clientRequestId ?? null;
    const attribution = attributionOf(operator);
    // Rabatt nur mit Recht `discount` (Bedienung ohne Schalter: 403).
    if (
      Number(createDto.discountAmount || 0) > 0 ||
      Number(createDto.payment?.discountAmount || 0) > 0
    ) {
      assertOperatorMay(operator, 'discount');
    }

    // Wiederholung derselben Anlage: bestehende Bestellung zurueckgeben,
    // nichts drucken, nichts melden.
    if (clientRequestId) {
      const existing = await this.findOrderByClientRequest(
        organizationId,
        clientRequestId,
      );
      if (existing) {
        response.status(HttpStatus.OK);
        return {
          data: await this.settleExisting(
            existing,
            createDto,
            device,
            attribution,
          ),
        };
      }
    }

    // Validate event
    let event: Event | null = null;
    let plannedTest = false;
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

      // Phase der Veranstaltung (inaktiv/beendet: keine neue Bestellung;
      // Testmodus und „Geplant“: Testbestellung mit Deckel).
      plannedTest = (await this.eventPhase.prepareOrder(event, 'pos'))
        .plannedTest;
    }

    // „Nur Bons“: Bestellungen ja, aber ohne Zahlung, Trinkgeld und
    // Rabatt (403 ORDER_ONLY_MODE), bevor irgendetwas angelegt wird.
    if (createDto.payment || Number(createDto.tipAmount || 0) > 0) {
      await this.assertPaymentsAllowedFor(organizationId);
    }

    // Testmodus: keine echte SumUp-Kartenzahlung; Bar und manuelle Karte
    // gehen weiter.
    if (createDto.payment) {
      assertSumUpAllowedInMode(
        plannedTest ? EventStatus.TEST : event?.status,
        createDto.payment.paymentMethod,
      );
      // Bargeldloser Modus: gar nicht erst eine Bestellung anlegen, die
      // settle() danach wieder zurueckrollen muesste.
      await this.assertPaymentMethodAllowed(
        organizationId,
        createDto.payment.paymentMethod,
      );
    }

    // Bestellung, Positionen, Bestand und Summen in einer Transaktion:
    // scheitert eine Position (Bestand, Produkt), bleibt keine leere
    // Bestellung zurueck, die eine Wiederholung dann ausliefern wuerde.
    let created: {
      order: Order;
      stockChanges: Product[];
      settled: SettledBatch | null;
      /** Summe 0 ohne Zahlung als bezahlt markiert (Beleg ueber 0,00). */
      zeroPaid?: boolean;
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
            {
              organizationId,
              eventId: createDto.eventId || null,
              plannedTest,
            },
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
              // Bedienung der Sitzung: nimmt auf und ist verantwortlich.
              createdByWaiterId: attribution.waiterId,
              waiterId: attribution.waiterId,
              createdByUserId: attribution.userId,
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
          // „Nur Bons“: kein Pfand (keine Betraege).
          const chargePfand =
            !isOrdersOnly(organization) &&
            isPfandChargedForFulfillment(
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
                attribution,
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
              attribution,
            );
            const paidOrder =
              settled.orders.find((o) => o.id === completeOrder.id) ??
              completeOrder;
            return { order: paidOrder, stockChanges, settled };
          }

          // „Nur Bons“: keine Zahlung, kein „Sofort kassieren“. Theken-
          // bestellungen ohne Station sind mit dem Anlegen ausgegeben und
          // damit abgeschlossen; alles andere schliesst die Ausgabe bzw.
          // „Abschließen“ (siehe operating-mode.util.ts).
          if (isOrdersOnly(organization)) {
            if (
              shouldAutoCompleteOrderOnly(
                completeOrder.fulfillmentType,
                completeOrder.items ?? [],
              )
            ) {
              const now = new Date();
              // Positionen ohne Station gelten als gleich mitgegeben —
              // sonst stuenden sie in der fertigen Bestellung auf „offen“.
              const handedOver = handOverOnCompletion(
                completeOrder.items ?? [],
                now,
              );
              if (handedOver.length) await manager.save(handedOver);
              completeOrder.status = OrderStatus.COMPLETED;
              completeOrder.completedAt = now;
              await manager.save(completeOrder);
            }
            return { order: completeOrder, stockChanges, settled: null };
          }

          // A fully-discounted order (total 0) has nothing to pay. Mark it
          // paid right away so the POS reaches the success screen without
          // sending a 0-amount payment (which the payment endpoint rejects).
          if (Number(completeOrder.total) <= 0) {
            completeOrder.paymentStatus = PaymentStatus.PAID;
            completeOrder.paidAmount = 0;
            await manager.save(completeOrder);
            return {
              order: completeOrder,
              stockChanges,
              settled: null,
              zeroPaid: true,
            };
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
            data: await this.settleExisting(
              existing,
              createDto,
              device,
              attribution,
            ),
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

    // Cloud-TSE vor jedem Kuechen-/Stationsbon („keine Kuechenbons ohne
    // TSE-Spur“, Steuerberater 2026-11-10, Frage 19): sofort bezahlt →
    // Kassenbelege der Zahlungen; ohne Zahlung (Tisch, „Senden“ an der
    // Theke) → Bestellvorgang (Bestellung-V1); voll rabattiert → Beleg ueber
    // 0,00. Erfassung und Zahlung kommen an der Kasse in einer Anfrage, die
    // Transaktion beginnt also mit der Erfassung im System. Signieren wirft
    // nie und ist durch TSE_SIGN_BUDGET_MS begrenzt; bei Ausfall druckt die
    // Kueche trotzdem (der Ausfall ist protokolliert).
    const signer = {
      terminal: device.id,
      waiterId: attribution.waiterId,
      userId: attribution.userId,
      operatorName: attribution.name,
    };
    let orderTse: TseReceiptView | null = null;
    if (created.settled) {
      await this.paymentsBatchService.signSettled(created.settled, {
        deviceId: device.id,
        waiterId: attribution.waiterId,
        userId: attribution.userId,
      });
    } else if (created.zeroPaid) {
      orderTse =
        (await this.tseSigning?.signZeroReceipt(completeOrder.id, signer)) ??
        null;
    } else {
      orderTse =
        (await this.tseSigning?.signOrderCreated(completeOrder.id, signer)) ??
        null;
    }

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

    // Zahlungsereignisse und Kassenbon nach dem Küchenbon; die Kassenbelege
    // sind oben schon signiert (TSE), der Bon traegt die Signatur.
    if (created.settled) {
      await this.paymentsBatchService.afterCommit(
        organizationId,
        created.settled,
        {
          deviceId: device.id,
          waiterId: attribution.waiterId,
          userId: attribution.userId,
        },
      );
    }

    return {
      data: Object.assign(completeOrder, {
        tseTransactions: collectTseViews(orderTse, created.settled),
      }),
    };
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
    attribution: Attribution,
  ): Promise<Order> {
    const open =
      (existing.paymentStatus === PaymentStatus.UNPAID ||
        existing.paymentStatus === PaymentStatus.PARTLY_PAID) &&
      !existing.closedWithoutPaymentAt;
    if (!createDto.payment || !open) return existing;

    const organizationId = requireOrganization(device);
    const { orderIds: others = [], ...payment } = createDto.payment;
    const settled = await this.orderRepository.manager.transaction((manager) =>
      this.paymentsBatchService.settle(
        manager,
        organizationId,
        device.id,
        {
          ...payment,
          orderIds: [...others.filter((id) => id !== existing.id), existing.id],
        },
        attribution,
      ),
    );
    await this.paymentsBatchService.afterCommit(organizationId, settled, {
      deviceId: device.id,
      waiterId: attribution.waiterId,
      userId: attribution.userId,
    });
    const order = settled.orders.find((o) => o.id === existing.id) ?? existing;
    return Object.assign(order, {
      tseTransactions: collectTseViews(null, settled),
    });
  }

  @Post('payments')
  @ApiOperation({ summary: 'Create a payment for an order from device' })
  @WithOperator()
  async createPayment(
    @CurrentDevice() device: Device,
    @Body() createDto: CreatePaymentDto,
    @CurrentOperator() operator: Operator | null = null,
  ) {
    const organizationId = requireOrganization(device);
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
    if (createDto.amount > remainingAmount + 0.01) {
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
    await this.assertSumUpAllowedForOrder(order, createDto.paymentMethod);

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
      processedByWaiterId: operator?.waiterId ?? null,
      processedByUserId: operator?.userId ?? null,
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

    // Cloud-TSE: Kassenbeleg signieren, bevor der Bon entsteht (wirft nie;
    // bei Ausfall traegt der Bon den Vermerk).
    const tse = (await this.tseSigning?.signPayment(payment.id)) ?? null;

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
        tse,
      })
      .catch((err) =>
        this.logger.error(
          `Auto-receipt on payment ${payment.id} failed: ${(err as Error).message}`,
        ),
      );

    return { data: Object.assign(payment, { tse }) };
  }

  @Post('payments/split')
  @ApiOperation({
    summary: 'Create a split payment for specific items from device',
  })
  @WithOperator()
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
    @CurrentOperator() operator: Operator | null = null,
  ) {
    const organizationId = requireOrganization(device);
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
    await this.assertPaymentMethodAllowed(
      organizationId,
      createDto.paymentMethod,
    );
    await this.assertSumUpAllowedForOrder(order, createDto.paymentMethod);

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
      processedByWaiterId: operator?.waiterId ?? null,
      processedByUserId: operator?.userId ?? null,
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

    // Cloud-TSE: Kassenbeleg der Teilzahlung (bezahlte Positionen).
    const tse = (await this.tseSigning?.signPayment(payment.id)) ?? null;

    // Kassenbon wie bei der Einzelzahlung (fehlte bei Split-Zahlungen).
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
      .catch((err) =>
        this.logger.error(
          `Auto-receipt on split payment ${payment.id} failed: ${(err as Error).message}`,
        ),
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

    return { data: Object.assign(payment, { tse }) };
  }

  // Cash Drawer

  @Post('cash-drawer/open')
  @WithOperator()
  @ApiOperation({
    summary: 'Open the cash drawer via configured printer',
    description:
      '`reason: payment` beim Barkassieren (immer erlaubt). Von Hand (`manual`, Standard) braucht eine Bedienung das Recht `cashDrawer`, sonst 403 WAITER_NOT_PERMITTED.',
  })
  async openCashDrawer(
    @CurrentDevice() device: Device,
    @Body() body: { reason?: 'payment' | 'manual' } = {},
    @CurrentOperator() operator: Operator | null = null,
  ) {
    const organizationId = requireOrganization(device);
    if (body?.reason !== 'payment') assertOperatorMay(operator, 'cashDrawer');
    // Bargeldlos: keine Kassenlade (ein reiner Bargeldvorgang).
    await this.assertPaymentMethodAllowed(organizationId);
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
  @ApiOperation({
    summary: 'Initiate SumUp checkout on linked card reader',
    description:
      'Im Testmodus der Veranstaltung abgelehnt (400 SUMUP_DISABLED_IN_TEST_MODE): Testbestellungen lösen keine echten Kartenzahlungen aus. Status und Abbruch bleiben erreichbar.',
  })
  @WithOperator()
  async initiateSumupCheckout(
    @CurrentDevice() device: Device,
    @Body() body: { amount: number; currency?: string },
  ) {
    const organizationId = requireOrganization(device);
    await this.assertPaymentsAllowedFor(organizationId);
    // Testmodus: keine echte Kartenzahlung (400 SUMUP_DISABLED_IN_TEST_MODE).
    await this.assertSumUpAllowedForOrganization(organizationId);
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
    summary: 'Bestellverlauf der Kasse (Filter und Seiten serverseitig)',
    description:
      'Neueste zuerst. `cursor` aus `meta.nextCursor` lädt die nächste Seite („Mehr laden“). `displayStatus` (kommagetrennt): in_kitchen, ready, completed, unpaid, cancelled, partly_refunded, refunded. `paymentMethod`: cash, card, sumup, discount. `scope=device`: nur Bestellungen dieser Kasse. `from`/`to`: ISO-Zeitpunkte. `q`: Nummer, Tisch, Name oder Produkt. `meta.counts` zählt je Status bei sonst gleichen Filtern. Alte Kassen: `status` und `page` wirken wie bisher.',
  })
  @ApiQuery({ name: 'eventId', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'displayStatus', required: false })
  @ApiQuery({ name: 'paymentMethod', required: false })
  @ApiQuery({ name: 'scope', required: false, enum: ['device', 'all'] })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'page', required: false })
  async getAllOrders(
    @CurrentDevice() device: Device,
    @Query()
    query: {
      status?: string;
      eventId?: string;
      page?: string;
      limit?: string;
      q?: string;
      displayStatus?: string;
      paymentMethod?: string;
      scope?: string;
      from?: string;
      to?: string;
      cursor?: string;
    },
  ) {
    const organizationId = requireOrganization(device);
    const filters = parseHistoryFilters(query);
    if (
      filters.status &&
      !Object.values(OrderStatus).includes(filters.status as OrderStatus)
    ) {
      filters.status = null;
    }
    if (query.scope === 'device') filters.deviceId = device.id;
    const page = query.page ? parseInt(query.page, 10) || 1 : null;
    return this.orderHistoryService.list(organizationId, filters, {
      limit: parseInt(query.limit || '50', 10) || 50,
      cursor: query.cursor ?? null,
      page,
    });
  }

  @Get('orders/:orderId')
  @ApiOperation({
    summary:
      'Bestellung im Detail: Positionen mit Status, Zahlungen, Erstattungen, Verlauf',
  })
  async getOrderDetail(
    @CurrentDevice() device: Device,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    const organizationId = requireOrganization(device);
    return {
      data: await this.orderHistoryService.detail(organizationId, orderId),
    };
  }

  @Get('orders/:orderId/tse')
  @ApiOperation({
    summary: 'TSE-Daten einer Bestellung (Kasse)',
    description:
      'Alle TSE-Vorgänge der Bestellung in zeitlicher Reihenfolge — Bestellvorgang, Kassenbelege (auch Teil- und Sammelzahlungen), Gegenbelege der Erstattungen — je mit `kind`, `status`, Signatur, QR-Code-Inhalt (`qrCode`, DSFinV-K Anhang I) und Bezug (`paymentId`, `refundId`). Nur Bestellungen der Organisation des Geräts (sonst 404). Leer ohne Cloud-TSE. Liest nur gespeicherte Daten, signiert nichts.',
  })
  async getOrderTse(
    @CurrentDevice() device: Device,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<{ data: TseReceiptView[] }> {
    const organizationId = requireOrganization(device);
    const order = await this.orderRepository.findOne({
      where: { id: orderId, organizationId },
      select: { id: true },
    });
    if (!order) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.ORDER_NOT_FOUND,
        message: 'Bestellung nicht gefunden',
      });
    }
    return {
      data: (await this.tseSigning?.forOrder(order.id, organizationId)) ?? [],
    };
  }

  @Post('orders/:orderId/cancel')
  @ApiOperation({
    summary: 'Ganze Bestellung stornieren (nur unbezahlt)',
    description:
      'Bezahlte oder teilweise bezahlte Bestellungen: 400 ORDER_PAID_REFUND_REQUIRED — stattdessen `POST orders/:orderId/refunds` mit `mode: full, cancelItems: true`. Bestand zurück nur für Positionen, mit denen die Küche noch nicht begonnen hat. Berechtigung je Gerät (`refundPermission`).',
  })
  @WithOperator()
  async cancelOrder(
    @CurrentDevice() device: Device,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() body: CancelOrderWithActorDto,
    @CurrentOperator() operator: Operator | null = null,
  ) {
    requireOrganization(device);
    const actor = await this.refundsService.resolveDeviceActor(
      device,
      body,
      operator,
    );
    const { order } = await this.refundsService.cancelOrder(
      actor,
      orderId,
      body,
    );
    this.logger.log(
      `Order ${order.orderNumber} cancelled by device ${device.name}`,
    );
    return { data: order };
  }

  @Post('orders/:orderId/cancel-items')
  @ApiOperation({
    summary: 'Positionen oder Teilmengen stornieren (ohne Erstattung)',
    description:
      'Solange die Küche nicht begonnen hat (`pending`): Bestand zurück, Station entfernt sie live, Storno-Bon an den Stationsdrucker. In Arbeit/fertig/serviert nur mit `confirmStarted` und Grund (Ausschuss, kein Bestand zurück), sonst 409 ORDER_ITEM_ALREADY_STARTED. Sinkt die Summe unter das schon Bezahlte: 400 ORDER_PAID_REFUND_REQUIRED.',
  })
  @WithOperator()
  async cancelOrderItems(
    @CurrentDevice() device: Device,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() body: CancelItemsDto,
    @CurrentOperator() operator: Operator | null = null,
  ) {
    const organizationId = requireOrganization(device);
    const actor = await this.refundsService.resolveDeviceActor(
      device,
      body,
      operator,
    );
    await this.refundsService.cancelItems(actor, orderId, body);
    return {
      data: await this.orderHistoryService.detail(organizationId, orderId),
    };
  }

  @Post('orders/:orderId/refunds')
  @ApiOperation({
    summary:
      'Erstattung mit Gegenbeleg (Teil-, Positions- oder Vollerstattung)',
    description:
      'Jede Erstattung ist ein eigener Beleg mit negativen Beträgen, MwSt je Satz und Bezug auf Bestellung und Zahlung; er wird auf dem Kassenbon-Drucker gedruckt. Rückgabeweg je ursprünglicher Zahlart: bar (Kassenlade öffnet), SumUp (Erstattung über die SumUp-API; Fehler: 400 REFUND_PROVIDER_FAILED, Wiederholung mit `manual: true` bucht „manuell erstattet“), fremdes Kartengerät (manuell). Im Testmodus wird bei SumUp nichts erstattet. `cancelItems` storniert die Positionen zugleich (Storno bezahlter Bestellungen).',
  })
  @WithOperator()
  async createRefund(
    @CurrentDevice() device: Device,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() body: CreateRefundDto,
    @CurrentOperator() operator: Operator | null = null,
  ) {
    const organizationId = requireOrganization(device);
    // „Nur Bons“: die Kasse vor Ort erstattet nie (auch nicht online).
    await this.assertPaymentsAllowedFor(organizationId);
    const actor = await this.refundsService.resolveDeviceActor(
      device,
      body,
      operator,
    );
    const outcome = await this.refundsService.createRefund(
      actor,
      orderId,
      body,
    );
    this.logger.log(
      `Refund on order ${outcome.order.orderNumber} by device ${device.name}: ${outcome.refunds.map((r) => `${r.refundNumber} ${r.amount}`).join(', ')}`,
    );
    return {
      data: {
        refunds: outcome.refunds.map((r) => ({
          id: r.id,
          refundNumber: r.refundNumber,
          amount: Number(r.amount),
          paymentMethod: r.paymentMethod,
          status: r.status,
          printed: (r as typeof r & { printed?: boolean }).printed ?? false,
          tse: (r as typeof r & { tse?: unknown }).tse ?? null,
        })),
        order: await this.orderHistoryService.detail(organizationId, orderId),
      },
    };
  }

  @Post('orders/:orderId/refunds/:refundId/reprint')
  @ApiOperation({ summary: 'Gegenbeleg einer Erstattung nachdrucken' })
  async reprintRefund(
    @CurrentDevice() device: Device,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('refundId', ParseUUIDPipe) refundId: string,
  ) {
    const organizationId = requireOrganization(device);
    // Nachdruck ist immer erlaubt (auch bei „nur mit PIN“/„aus“).
    const actor = {
      organizationId,
      deviceId: device.id,
      deviceName: device.name,
      userId: null,
      actorName: null,
      cashDrawerPrinterId: null,
    };
    const printed = await this.refundsService.reprintRefund(
      actor,
      orderId,
      refundId,
    );
    return { data: { success: true, printed } };
  }

  @Post('orders/:orderId/reprint')
  @ApiOperation({ summary: 'Reprint tickets or receipt for an order' })
  async reprintOrder(
    @CurrentDevice() device: Device,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() body: ReprintDto,
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
      // „Nur Bons“: keine Kassenbons (keine Preise).
      await this.assertPaymentsAllowedFor(organizationId);
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
        // Nachdruck: gespeicherte TSE-Daten, keine neue Transaktion. Druckt
        // auch ohne automatischen Kassenbon; „NACHDRUCK“, wenn schon einer
        // gedruckt wurde.
        onDemand: true,
        tse: (await this.tseSigning?.forPayment(lastPayment.id)) ?? null,
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
    await this.refundsService.recordReprint(
      {
        organizationId,
        deviceId: device.id,
        deviceName: device.name,
        userId: null,
        actorName: null,
        cashDrawerPrinterId: null,
      },
      order.id,
      printType,
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
    attribution: Attribution,
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
    // Steuersatz des Pfands festhalten (Teil des Entgelts, Satz der Pfandart).
    const depositTaxRate =
      depositAmount > 0 ? pfandVatRate(product.pfandType) : null;

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
      depositTaxRate,
      isRefill,
      // Runden-Sender (Küchenbon, Kellnerabrechnung).
      addedByWaiterId: attribution.waiterId,
      addedByUserId: attribution.userId,
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
    // Pfand (deposit) is added on top and is never discounted. It is part of
    // the consideration: taxTotal includes it at the rate of its Pfand type.
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
   * Darf die Organisation mit dieser Zahlart buchen?
   *
   * - SumUp nur bei eingeschaltetem SumUp. `card` ist ein fremdes
   *   Kartengeraet ohne Anbindung und bleibt immer moeglich.
   * - Bargeld nur, wo die Betriebsart es erlaubt (`assertCashAllowed`:
   *   nicht in `cashless`, in Deutschland nur mit TSE). Ohne Zahlart gilt
   *   der Vorgang als reiner Bargeldvorgang (Kassenlade).
   */
  private async assertPaymentMethodAllowed(
    organizationId: string,
    method?: PaymentMethod,
  ): Promise<void> {
    // „Nur Bons“ zuerst: dort gibt es gar keine Zahlart (und keine
    // Kassenlade) — 403 ORDER_ONLY_MODE statt einer Zahlart-Meldung.
    await this.assertPaymentsAllowedFor(organizationId);
    const sumup =
      method !== undefined &&
      this.getProviderForMethod(method) === PaymentProvider.SUMUP;
    const cash = method === undefined || method === PaymentMethod.CASH;
    if (!sumup && !cash) return;
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: OPERATING_MODE_SELECT,
    });
    if (sumup) assertIntegrationEnabled(organization?.settings, 'sumup');
    assertCashAllowed(organization, method);
  }

  /** Betriebsart „Nur Bons“ (orders_only)? */
  private async isOrdersOnlyOrg(organizationId: string): Promise<boolean> {
    return isOrdersOnly(
      await this.organizationRepository.findOne({
        where: { id: organizationId },
        select: OPERATING_MODE_SELECT,
      }),
    );
  }

  /** 403 ORDER_ONLY_MODE, wenn die Organisation „Nur Bons“ nutzt. */
  private async assertPaymentsAllowedFor(
    organizationId: string,
  ): Promise<void> {
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: OPERATING_MODE_SELECT,
    });
    assertPaymentsAllowed(organization);
  }

  /**
   * Testmodus der Organisation (auch „Geplant“): kein SumUp-Checkout am
   * Lesegeraet.
   */
  private async assertSumUpAllowedForOrganization(
    organizationId: string,
  ): Promise<void> {
    const events = await this.eventRepository.find({
      where: {
        organizationId,
        status: In([EventStatus.ACTIVE, EventStatus.TEST]),
      },
    });
    const effective = await Promise.all(
      events.map(async (event) => ({
        status: (await this.eventPhase.isTestModeNow(event))
          ? EventStatus.TEST
          : event.status,
      })),
    );
    assertSumUpAllowedInMode(currentEventStatus(effective));
  }

  /** Testbestellung: keine SumUp-Zahlung buchen (Bar/Karte manuell gehen). */
  private async assertSumUpAllowedForOrder(
    order: Pick<Order, 'eventId'> & { isTest?: boolean },
    method: PaymentMethod,
  ): Promise<void> {
    if (method !== PaymentMethod.SUMUP_TERMINAL || !order.eventId) return;
    if (order.isTest === true) {
      assertSumUpAllowedInMode(EventStatus.TEST, method);
    }
    const event = await this.eventRepository.findOne({
      where: { id: order.eventId },
      select: { id: true, status: true },
    });
    assertSumUpAllowedInMode(event?.status, method);
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

/**
 * TSE-Vorgaenge einer Kassen-Anfrage fuer die Antwort (`tseTransactions`):
 * Bestellvorgang bzw. 0,00-Beleg, Kassenbelege der Zahlungen, 0,00-Belege
 * der Sammelzahlung. Leer ohne aktive TSE.
 */
function collectTseViews(
  orderView: TseReceiptView | null,
  settled: SettledBatch | null,
): TseReceiptView[] {
  const views: TseReceiptView[] = [];
  if (orderView) views.push(orderView);
  for (const payment of settled?.payments ?? []) {
    if (payment.tse) views.push(payment.tse);
  }
  views.push(...(settled?.zeroReceipts ?? []));
  return views;
}
