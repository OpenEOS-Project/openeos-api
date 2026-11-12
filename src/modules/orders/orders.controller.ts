import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  Logger,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { OrdersService } from './orders.service';
import { OrdersExportService } from './orders-export.service';
import { RefundsService } from '../refunds/refunds.service';
import { OrderHistoryService } from '../refunds/order-history.service';
import { CancelItemsDto, CreateRefundDto } from '../refunds/dto/refund.dto';
import { CurrentUser, ApiTokenAccess } from '../../common/decorators';
import { TokenScope } from '../api-tokens/api-scopes';
import { User } from '../../database/entities';
import {
  CreateOrderDto,
  UpdateOrderDto,
  AddOrderItemDto,
  UpdateOrderItemDto,
  QueryOrdersDto,
  CancelOrderDto,
  ExportOrdersDto,
} from './dto';
import { ORDERS_EXPORT_RESPONSE, ORDERS_LIST_RESPONSE } from './orders.openapi';

@ApiTags('Orders')
@ApiParam({
  name: 'organizationId',
  description: 'ID der Organisation',
  format: 'uuid',
})
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/orders')
export class OrdersController {
  private readonly logger = new Logger(OrdersController.name);

  constructor(
    private readonly ordersService: OrdersService,
    private readonly ordersExportService: OrdersExportService,
    private readonly refundsService: RefundsService,
    private readonly orderHistoryService: OrderHistoryService,
  ) {}

  @Post()
  create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() createDto: CreateOrderDto,
    @CurrentUser() user: User,
  ) {
    return this.ordersService.create(organizationId, createDto, user);
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get()
  @ApiOperation({
    operationId: 'listOrders',
    summary: 'Bestellungen auflisten',
    description:
      'Bestellungen der Organisation, neueste zuerst, seitenweise (höchstens 100 je Seite) und filterbar nach Veranstaltung, Status, Zahlart, Gerät und Zeitraum; `includeItems=true` liefert die Positionen mit. Scope `read`. Anlegen, Stornieren und Erstatten sind der Kasse und der App vorbehalten.',
  })
  @ApiResponse(ORDERS_LIST_RESPONSE)
  findAll(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() query: QueryOrdersDto,
    @CurrentUser() user: User,
  ) {
    return this.ordersService.findAll(organizationId, user, query);
  }

  // Must be registered before ':orderId' below, otherwise Nest would match
  // GET /orders/stats as GET /orders/:orderId with orderId="stats".
  @ApiTokenAccess(TokenScope.READ)
  @Get('stats')
  @ApiOperation({
    operationId: 'getOrderStats',
    summary: 'Bestellstatistik',
    description:
      'Anzahl, Umsatz, Durchschnittsbon und Pfand über alle Bestellungen, die zu den Filtern passen — ohne Seitenwechsel; stornierte zählen in `count`, aber nicht in die Beträge. Scope `read`.',
  })
  getStats(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() query: QueryOrdersDto,
    @CurrentUser() user: User,
  ) {
    return this.ordersService.getStats(organizationId, user, query);
  }

  // Wie 'stats' vor ':orderId' registriert.
  @ApiTokenAccess(TokenScope.READ)
  @Get('export')
  @ApiOperation({
    operationId: 'exportOrders',
    summary: 'Bestellungen als CSV exportieren',
    description:
      'Alle Bestellungen, die zu den Filtern passen (dieselben wie bei `GET …/orders`, ohne Seiten), als CSV-Download für Excel: Semikolon, UTF-8 mit BOM, Dezimalkomma, Datum und Uhrzeit in deutscher Zeit (Europe/Berlin), älteste zuerst. `variant=orders` liefert eine Zeile je Bestellung, `variant=items` eine Zeile je Position. In der Betriebsart „Nur Bons“ (`orders_only`) nur Mengen, keine Beträge. Gastname und Anmerkungen stehen nur, solange sie gespeichert sind (sie werden 30 Tage nach der Veranstaltung gelöscht); Telefonnummern nie. Scope `read`; der Token-Besitzer braucht Admin oder das Recht „Bestellungen“.',
  })
  @ApiProduces('text/csv')
  @ApiResponse(ORDERS_EXPORT_RESPONSE)
  async exportCsv(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() query: ExportOrdersDto,
    @CurrentUser() user: User,
    @Res() res: Response,
  ): Promise<void> {
    // Rechte und Filter vor der ersten Zeile pruefen — bis hierhin laufen
    // Fehler als normale JSON-Antwort.
    const file = await this.ordersExportService.prepare(
      organizationId,
      user,
      query,
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.filename}"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    try {
      for await (const chunk of file.chunks) {
        if (res.destroyed) return;
        if (!res.write(chunk)) {
          await new Promise<void>((resolve) => {
            res.once('drain', resolve);
            res.once('close', resolve);
          });
        }
      }
      res.end();
    } catch (error) {
      // Kopfzeilen sind schon raus: abbrechen statt halbe Datei als fertig
      // auszugeben.
      this.logger.error(
        `Order export failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      res.destroy(error instanceof Error ? error : undefined);
    }
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get(':orderId')
  @ApiOperation({
    operationId: 'getOrder',
    summary: 'Bestellung abrufen',
    description: 'Eine Bestellung mit Positionen und Zahlungen. Scope `read`.',
  })
  @ApiParam({
    name: 'orderId',
    description: 'ID der Bestellung',
    format: 'uuid',
  })
  findOne(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @CurrentUser() user: User,
  ) {
    return this.ordersService.findOne(organizationId, orderId, user);
  }

  @Patch(':orderId')
  @ApiOperation({
    summary: 'Bestellung ändern',
    description:
      'Offene, unbezahlte Bestellungen ändert jedes Mitglied. Bezahlte oder teilbezahlte Bestellungen: Recht „Bestellungen“ oder Admin (sonst 403 ORDERS_PERMISSION_REQUIRED). Gilt auch für Positionen.',
  })
  update(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() updateDto: UpdateOrderDto,
    @CurrentUser() user: User,
  ) {
    return this.ordersService.update(organizationId, orderId, updateDto, user);
  }

  @Delete(':orderId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Unbezahlte Bestellung löschen',
    description:
      'Recht „Bestellungen“ oder Admin (sonst 403 ORDERS_PERMISSION_REQUIRED).',
  })
  remove(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @CurrentUser() user: User,
  ) {
    return this.ordersService.remove(organizationId, orderId, user);
  }

  // Order Items

  @Post(':orderId/items')
  addItem(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() itemDto: AddOrderItemDto,
    @CurrentUser() user: User,
  ) {
    return this.ordersService.addItem(organizationId, orderId, itemDto, user);
  }

  @Patch(':orderId/items/:itemId')
  updateItem(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() updateDto: UpdateOrderItemDto,
    @CurrentUser() user: User,
  ) {
    return this.ordersService.updateItem(
      organizationId,
      orderId,
      itemId,
      updateDto,
      user,
    );
  }

  @Delete(':orderId/items/:itemId')
  removeItem(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @CurrentUser() user: User,
  ) {
    return this.ordersService.removeItem(organizationId, orderId, itemId, user);
  }

  // Status Updates

  @Post(':orderId/items/:itemId/ready')
  @HttpCode(HttpStatus.OK)
  markItemReady(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @CurrentUser() user: User,
  ) {
    return this.ordersService.markItemReady(
      organizationId,
      orderId,
      itemId,
      user,
    );
  }

  @Post(':orderId/items/:itemId/deliver')
  @HttpCode(HttpStatus.OK)
  markItemDelivered(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @CurrentUser() user: User,
  ) {
    return this.ordersService.markItemDelivered(
      organizationId,
      orderId,
      itemId,
      user,
    );
  }

  @Post(':orderId/call')
  @HttpCode(HttpStatus.OK)
  callOrder(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @CurrentUser() user: User,
  ) {
    return this.ordersService.callOrder(organizationId, orderId, user);
  }

  @Post(':orderId/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bestellung abschließen',
    description:
      'Bezahlte Bestellungen schließt jedes Mitglied ab. Ohne vollständige Zahlung (Betriebsart „Nur Bons“): Recht „Bestellungen“ oder Admin (sonst 403 ORDERS_PERMISSION_REQUIRED).',
  })
  completeOrder(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @CurrentUser() user: User,
  ) {
    return this.ordersService.completeOrder(organizationId, orderId, user);
  }

  @Post(':orderId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ganze Bestellung stornieren (nur unbezahlt)',
    description:
      'Bezahlte Bestellungen: 400 ORDER_PAID_REFUND_REQUIRED — stattdessen Erstattung mit `mode: full, cancelItems: true`. Recht „Bestellungen“ oder Admin.',
  })
  async cancelOrder(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() cancelDto: CancelOrderDto,
    @CurrentUser() user: User,
  ) {
    const actor = await this.refundsService.resolveAdminActor(
      organizationId,
      user,
    );
    await this.refundsService.cancelOrder(actor, orderId, cancelDto);
    return this.ordersService.findOne(organizationId, orderId, user);
  }

  @Get(':orderId/history')
  @ApiOperation({
    summary:
      'Bestellung im Detail wie in der Kasse: Positionen, Zahlungen, Erstattungen, Verlauf',
  })
  async getHistory(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @CurrentUser() user: User,
  ) {
    await this.ordersService.findOne(organizationId, orderId, user);
    return this.orderHistoryService.detail(organizationId, orderId);
  }

  @Post(':orderId/cancel-items')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Positionen stornieren (ohne Erstattung), wie an der Kasse',
  })
  async cancelItems(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: CancelItemsDto,
    @CurrentUser() user: User,
  ) {
    const actor = await this.refundsService.resolveAdminActor(
      organizationId,
      user,
    );
    await this.refundsService.cancelItems(actor, orderId, dto);
    return this.orderHistoryService.detail(organizationId, orderId);
  }

  @Post(':orderId/refunds')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Erstattung mit Gegenbeleg (gleiche Regeln wie an der Kasse)',
  })
  async createRefund(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: CreateRefundDto,
    @CurrentUser() user: User,
  ) {
    const actor = await this.refundsService.resolveAdminActor(
      organizationId,
      user,
    );
    const outcome = await this.refundsService.createRefund(actor, orderId, dto);
    return {
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
    };
  }

  @Post(':orderId/refunds/:refundId/reprint')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Gegenbeleg nachdrucken' })
  async reprintRefund(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('refundId', ParseUUIDPipe) refundId: string,
    @CurrentUser() user: User,
  ) {
    await this.ordersService.findOne(organizationId, orderId, user);
    const printed = await this.refundsService.reprintRefund(
      {
        organizationId,
        deviceId: null,
        deviceName: null,
        userId: user.id,
        actorName:
          `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || null,
        cashDrawerPrinterId: null,
      },
      orderId,
      refundId,
    );
    return { success: true, printed };
  }
}
