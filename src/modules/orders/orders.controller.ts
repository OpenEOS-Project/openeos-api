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
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { OrdersService } from './orders.service';
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
  constructor(private readonly ordersService: OrdersService) {}

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
    return this.ordersService.updateItem(organizationId, orderId, itemId, updateDto, user);
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
    return this.ordersService.markItemReady(organizationId, orderId, itemId, user);
  }

  @Post(':orderId/items/:itemId/deliver')
  @HttpCode(HttpStatus.OK)
  markItemDelivered(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @CurrentUser() user: User,
  ) {
    return this.ordersService.markItemDelivered(organizationId, orderId, itemId, user);
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
  cancelOrder(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() cancelDto: CancelOrderDto,
    @CurrentUser() user: User,
  ) {
    return this.ordersService.cancelOrder(organizationId, orderId, cancelDto, user);
  }
}
