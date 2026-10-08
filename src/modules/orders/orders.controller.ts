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
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { OrdersService } from './orders.service';
import { RefundsService } from '../refunds/refunds.service';
import { OrderHistoryService } from '../refunds/order-history.service';
import { CancelItemsDto, CreateRefundDto } from '../refunds/dto/refund.dto';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';
import {
  CreateOrderDto,
  UpdateOrderDto,
  AddOrderItemDto,
  UpdateOrderItemDto,
  QueryOrdersDto,
  CancelOrderDto,
} from './dto';

@ApiTags('Orders')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/orders')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
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

  @Get()
  findAll(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() query: QueryOrdersDto,
    @CurrentUser() user: User,
  ) {
    return this.ordersService.findAll(organizationId, user, query);
  }

  // Must be registered before ':orderId' below, otherwise Nest would match
  // GET /orders/stats as GET /orders/:orderId with orderId="stats".
  @Get('stats')
  getStats(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() query: QueryOrdersDto,
    @CurrentUser() user: User,
  ) {
    return this.ordersService.getStats(organizationId, user, query);
  }

  @Get(':orderId')
  findOne(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @CurrentUser() user: User,
  ) {
    return this.ordersService.findOne(organizationId, orderId, user);
  }

  @Patch(':orderId')
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
