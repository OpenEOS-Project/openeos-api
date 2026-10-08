import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { CurrentDevice } from '../../common/decorators';
import { Public } from '../../common/decorators/public.decorator';
import { DeviceAuthGuard } from '../../common/guards/device-auth.guard';
import { Event, Order, Organization, Printer } from '../../database/entities';
import { Device, DeviceSettings } from '../../database/entities/device.entity';
import { EventStatus } from '../../database/entities/event.entity';
import { OrderSource, OrderStatus } from '../../database/entities/order.entity';
import { OrganizationSettings } from '../../database/entities/organization.entity';
import { GatewayService } from '../gateway/gateway.service';
import { OrdersService } from '../orders/orders.service';
import { BatchPaymentDto } from '../payments/dto/batch-payment.dto';
import { PaymentsBatchService } from '../payments/payments-batch.service';
import { tableKey } from '../tables/tables.constants';
import { TablesService } from '../tables/tables.service';
import { requireOrganization } from './device-api.controller';
import { effectiveTableMode } from './device-order-table';
import {
  AcknowledgeTableDto,
  DeliverOrderItemsDto,
} from './dto/device-tables.dto';

/** Agent meldet sich alle 30 s; nach drei verpassten Meldungen gilt er als weg. */
export const PRINTER_STALE_MS = 90_000;

/**
 * Bondrucker des Geraets: Geraete-Standarddrucker, sonst der Drucker fuer
 * Kassenbons aus dem Bestellablauf der Organisation, sonst keiner.
 */
export function resolveReceiptPrinterId(
  deviceSettings: DeviceSettings | null | undefined,
  organizationSettings: OrganizationSettings | null | undefined,
): string | null {
  return (
    deviceSettings?.defaultPrinterId ||
    organizationSettings?.orderFlow?.receiptPrinting?.printerId ||
    null
  );
}

export interface DevicePrinterStatus {
  id: string;
  name: string;
  isOnline: boolean;
  lastSeenAt: Date | null;
}

export function printerStatus(
  printer: Pick<
    Printer,
    'id' | 'name' | 'isOnline' | 'isActive' | 'lastSeenAt'
  >,
  now = new Date(),
): DevicePrinterStatus {
  const lastSeen = printer.lastSeenAt
    ? new Date(printer.lastSeenAt).getTime()
    : 0;
  return {
    id: printer.id,
    name: printer.name,
    isOnline:
      printer.isActive &&
      printer.isOnline &&
      lastSeen > 0 &&
      now.getTime() - lastSeen <= PRINTER_STALE_MS,
    lastSeenAt: printer.lastSeenAt,
  };
}

/**
 * Geraete-Endpunkte fuer Tische, Servieren, Sammelzahlung und Status
 * (Spezifikation §3.4). Eigener Controller, damit device-api.controller.ts
 * nicht weiter waechst.
 */
@ApiTags('Device API')
@ApiHeader({
  name: 'X-Device-Token',
  description: 'Device authentication token',
  required: true,
})
@Controller('device-api')
@Public() // Exclude from JWT guard
@UseGuards(DeviceAuthGuard)
export class DeviceTablesController {
  constructor(
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(Printer)
    private readonly printerRepository: Repository<Printer>,
    private readonly tablesService: TablesService,
    private readonly ordersService: OrdersService,
    private readonly paymentsBatchService: PaymentsBatchService,
    private readonly gatewayService: GatewayService,
  ) {}

  @Get('tables')
  @ApiOperation({
    summary: 'Table mode and active tables for the active/test event',
    description:
      'Bereiche mit aktiven Tischen, gefiltert auf `event.settings.tables.areaIds`. Ohne `eventId` gilt das aktive bzw. Test-Event.',
  })
  @ApiQuery({ name: 'eventId', required: false })
  async getTables(
    @CurrentDevice() device: Device,
    @Query('eventId', new ParseUUIDPipe({ optional: true })) eventId?: string,
  ) {
    const organizationId = requireOrganization(device);
    const event = await this.resolveEvent(organizationId, eventId);
    const mode = effectiveTableMode(event?.settings?.tables);
    const areas = event
      ? await this.tablesService.loadAreas(organizationId, {
          areaIds: event.settings?.tables?.areaIds ?? null,
          activeTablesOnly: true,
        })
      : [];

    return {
      data: {
        eventId: event?.id ?? null,
        mode,
        areas: areas.map((area) => ({
          id: area.id,
          name: area.name,
          sortOrder: area.sortOrder,
          width: area.width,
          height: area.height,
          gridSize: area.gridSize,
          decor: area.decor,
          outline: area.outline ?? null,
          tables: area.tables.map((t) => ({
            id: t.id,
            areaId: t.areaId,
            label: t.label,
            seats: t.seats,
            shape: t.shape,
            x: t.x,
            y: t.y,
            width: t.width,
            height: t.height,
            rotation: t.rotation,
            sortOrder: t.sortOrder,
          })),
        })),
      },
    };
  }

  @Get('tables/status')
  @ApiOperation({
    summary: 'Status of all non-free tables of the active/test event',
  })
  @ApiQuery({ name: 'eventId', required: false })
  async getTableStatus(
    @CurrentDevice() device: Device,
    @Query('eventId', new ParseUUIDPipe({ optional: true })) eventId?: string,
  ) {
    const organizationId = requireOrganization(device);
    const event = await this.resolveEvent(organizationId, eventId);
    if (!event) return { data: [] };
    return {
      data: await this.tablesService.getStatus(organizationId, event.id),
    };
  }

  @Post('tables/acknowledge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Acknowledge guest orders (shop/QR) of a table',
  })
  async acknowledgeTable(
    @CurrentDevice() device: Device,
    @Body() dto: AcknowledgeTableDto,
  ) {
    const organizationId = requireOrganization(device);
    const event = await this.resolveEvent(organizationId, dto.eventId);
    const key = tableKey(dto.tableKey);
    if (!event || !key) return { data: { acknowledged: 0, orderIds: [] } };

    const result = await this.orderRepository
      .createQueryBuilder()
      .update(Order)
      .set({ acknowledgedAt: () => 'now()' })
      .where('organization_id = :organizationId', { organizationId })
      .andWhere('event_id = :eventId', { eventId: event.id })
      .andWhere('upper(btrim(table_number)) = :key', { key })
      .andWhere('source IN (:...sources)', {
        sources: [OrderSource.ONLINE, OrderSource.QR_ORDER],
      })
      .andWhere('status = :status', { status: OrderStatus.OPEN })
      .andWhere('acknowledged_at IS NULL')
      .returning(['id', 'acknowledged_at'])
      .execute();

    const rows = (result.raw ?? []) as {
      id: string;
      acknowledged_at: Date;
    }[];
    for (const row of rows) {
      this.gatewayService.notifyOrderUpdated(organizationId, event.id, row.id, {
        acknowledgedAt: row.acknowledged_at,
      });
    }

    return {
      data: { acknowledged: rows.length, orderIds: rows.map((r) => r.id) },
    };
  }

  @Post('order-items/deliver')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark ready items as delivered (served at the table)',
  })
  async deliverItems(
    @CurrentDevice() device: Device,
    @Body() dto: DeliverOrderItemsDto,
  ) {
    const organizationId = requireOrganization(device);
    return {
      data: await this.ordersService.deliverItemsForDevice(
        organizationId,
        dto.itemIds,
      ),
    };
  }

  @Post('payments/batch')
  @ApiOperation({
    summary: 'Pay several open orders in one transaction',
    description:
      'Alles oder nichts: ist eine Bestellung bereits bezahlt, kommt 409 ORDER_ALREADY_PAID und nichts wird gebucht.',
  })
  async payBatch(
    @CurrentDevice() device: Device,
    @Body() dto: BatchPaymentDto,
  ) {
    const organizationId = requireOrganization(device);
    return {
      data: await this.paymentsBatchService.payBatch(
        organizationId,
        device.id,
        dto,
      ),
    };
  }

  @Get('status')
  @ApiOperation({
    summary: 'Receipt printer and TSE state for the POS status pills',
  })
  async getStatus(@CurrentDevice() device: Device) {
    const organizationId = requireOrganization(device);
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: { id: true, settings: true },
    });
    const printerId = resolveReceiptPrinterId(
      device.settings,
      organization?.settings,
    );
    const printer = printerId
      ? await this.printerRepository.findOne({
          where: { id: printerId, organizationId },
        })
      : null;

    return {
      data: {
        printer: printer ? printerStatus(printer) : null,
        // Wird mit der fiskaly-Anbindung (api #12) befuellt.
        tse: null,
      },
    };
  }

  /**
   * Event der Anfrage: angegebenes Event der Organisation (muss aktiv oder
   * im Test sein), sonst das aktive bzw. Test-Event, sonst null.
   */
  private async resolveEvent(
    organizationId: string,
    eventId: string | undefined,
  ): Promise<Event | null> {
    if (eventId) {
      const event = await this.eventRepository.findOne({
        where: { id: eventId, organizationId },
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
      return event;
    }
    const events = await this.eventRepository.find({
      where: {
        organizationId,
        status: In([EventStatus.ACTIVE, EventStatus.TEST]),
      },
      order: { status: 'ASC' },
      take: 1,
    });
    return events[0] ?? null;
  }
}
