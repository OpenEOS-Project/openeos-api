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
import { ProductsService } from './products.service';
import { CreateProductDto, UpdateProductDto, AdjustStockDto } from './dto';
import { ImportProductsDto } from './dto/import-products.dto';
import { CurrentUser, ApiTokenAccess } from '../../common/decorators';
import { TokenScope } from '../api-tokens/api-scopes';
import { User } from '../../database/entities';
import { PaginationDto } from '../../common/dto/pagination.dto';

@ApiTags('Products')
@ApiBearerAuth('JWT-auth')
@Controller('events/:eventId/products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @ApiTokenAccess(TokenScope.CATALOG_WRITE)
  @Post()
  async create(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() createDto: CreateProductDto,
    @CurrentUser() user: User,
  ) {
    const product = await this.productsService.create(eventId, createDto, user);
    return { data: product };
  }

  @ApiTokenAccess(TokenScope.CATALOG_WRITE)
  @Post('import')
  @HttpCode(HttpStatus.OK)
  async importProducts(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() importDto: ImportProductsDto,
    @CurrentUser() user: User,
  ) {
    const result = await this.productsService.importProducts(
      eventId,
      importDto,
      user,
    );
    return { data: result };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get()
  async findAll(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
    @Query() pagination: PaginationDto,
  ) {
    return this.productsService.findAll(eventId, user, pagination);
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get('low-stock')
  async getLowStock(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    const products = await this.productsService.getLowStock(eventId, user);
    return { data: products };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get(':productId')
  async findOne(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @CurrentUser() user: User,
  ) {
    const product = await this.productsService.findOne(
      eventId,
      productId,
      user,
    );
    return { data: product };
  }

  @ApiTokenAccess(TokenScope.CATALOG_WRITE)
  @Patch(':productId')
  async update(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() updateDto: UpdateProductDto,
    @CurrentUser() user: User,
  ) {
    const product = await this.productsService.update(
      eventId,
      productId,
      updateDto,
      user,
    );
    return { data: product };
  }

  @Delete(':productId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @CurrentUser() user: User,
  ) {
    await this.productsService.remove(eventId, productId, user);
  }

  @ApiTokenAccess(TokenScope.CATALOG_WRITE)
  @Patch(':productId/availability')
  async updateAvailability(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body('isAvailable') isAvailable: boolean,
    @CurrentUser() user: User,
  ) {
    const product = await this.productsService.updateAvailability(
      eventId,
      productId,
      isAvailable,
      user,
    );
    return { data: product };
  }

  @Post(':productId/stock/adjust')
  async adjustStock(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() adjustDto: AdjustStockDto,
    @CurrentUser() user: User,
  ) {
    const product = await this.productsService.adjustStock(
      eventId,
      productId,
      adjustDto,
      user,
    );
    return { data: product };
  }
}
