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
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { InventoryService } from './inventory.service';
import {
  CreateInventoryCountDto,
  UpdateInventoryCountDto,
  AddInventoryItemDto,
  BulkAddInventoryItemsDto,
  UpdateInventoryItemDto,
  QueryInventoryCountsDto,
  QueryStockMovementsDto,
} from './dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { User } from '../../database/entities';

@ApiTags('Inventory')
@ApiBearerAuth('JWT-auth')
@Controller('events/:eventId/inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  // === Inventory Counts ===

  @Get('counts')
  async findAllCounts(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Query() queryDto: QueryInventoryCountsDto,
  ) {
    const result = await this.inventoryService.findAllCounts(eventId, queryDto);
    return {
      data: result.data,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        pages: Math.ceil(result.total / result.limit),
      },
    };
  }

  @Get('counts/:id')
  async findOneCount(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const count = await this.inventoryService.findOneCount(eventId, id);
    return { data: count };
  }

  @Post('counts')
  async createCount(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
    @Body() createDto: CreateInventoryCountDto,
  ) {
    const count = await this.inventoryService.createCount(
      eventId,
      user.id,
      createDto,
    );
    return { data: count };
  }

  @Patch('counts/:id')
  async updateCount(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateDto: UpdateInventoryCountDto,
  ) {
    const count = await this.inventoryService.updateCount(eventId, id, updateDto);
    return { data: count };
  }

  @Delete('counts/:id')
  async deleteCount(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.inventoryService.deleteCount(eventId, id);
    return { data: { success: true } };
  }

  @Post('counts/:id/start')
  async startCount(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const count = await this.inventoryService.startCount(eventId, id);
    return { data: count };
  }

  @Post('counts/:id/complete')
  async completeCount(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const count = await this.inventoryService.completeCount(eventId, id, user.id);
    return { data: count };
  }

  @Post('counts/:id/cancel')
  async cancelCount(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const count = await this.inventoryService.cancelCount(eventId, id);
    return { data: count };
  }

  // === Inventory Count Items ===

  @Post('counts/:id/items')
  async addItem(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('id', ParseUUIDPipe) countId: string,
    @Body() addDto: AddInventoryItemDto,
  ) {
    const item = await this.inventoryService.addItem(eventId, countId, addDto);
    return { data: item };
  }

  @Post('counts/:id/items/bulk-add')
  async bulkAddItems(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('id', ParseUUIDPipe) countId: string,
    @Body() bulkDto: BulkAddInventoryItemsDto,
  ) {
    const items = await this.inventoryService.bulkAddItems(eventId, countId, bulkDto);
    return { data: items };
  }

  @Patch('counts/:countId/items/:itemId')
  async updateItem(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
    @Param('countId', ParseUUIDPipe) countId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() updateDto: UpdateInventoryItemDto,
  ) {
    const item = await this.inventoryService.updateItem(
      eventId,
      countId,
      itemId,
      user.id,
      updateDto,
    );
    return { data: item };
  }

  // === Stock Movements ===

  @Get('stock-movements')
  async findAllMovements(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Query() queryDto: QueryStockMovementsDto,
  ) {
    const result = await this.inventoryService.findAllMovements(eventId, queryDto);
    return {
      data: result.data,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        pages: Math.ceil(result.total / result.limit),
      },
    };
  }

  @Get('stock-movements/:id')
  async findOneMovement(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const movement = await this.inventoryService.findOneMovement(eventId, id);
    return { data: movement };
  }
}
