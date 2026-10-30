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
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ProductsService } from './products.service';
import { CreateProductDto, UpdateProductDto, AdjustStockDto } from './dto';
import { ImportProductsDto } from './dto/import-products.dto';
import { CurrentUser, ApiTokenAccess } from '../../common/decorators';
import { TokenScope } from '../api-tokens/api-scopes';
import { User } from '../../database/entities';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { PRODUCTS_LIST_RESPONSE } from './products.openapi';

@ApiTags('Products')
@ApiParam({
  name: 'eventId',
  description: 'ID der Veranstaltung',
  format: 'uuid',
})
@ApiBearerAuth('JWT-auth')
@Controller('events/:eventId/products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @ApiTokenAccess(TokenScope.CATALOG_WRITE)
  @Post()
  @ApiOperation({
    operationId: 'createProduct',
    summary: 'Produkt anlegen',
    description:
      'Legt ein Produkt in einer Kategorie der Veranstaltung an: Preis, Steuersatz, Optionen, Pfandart, Station, Bestand. Scope `catalog:write` und Modulrecht Produkte.',
  })
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
  @ApiOperation({
    operationId: 'importProducts',
    summary: 'Produkte importieren (CSV)',
    description:
      'Legt mehrere Produkte aus einer CSV-Liste in einem Aufruf an, fehlende Kategorien werden ergänzt; mit `dryRun` nur Vorschau. Scope `catalog:write`.',
  })
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
  @ApiOperation({
    operationId: 'listProducts',
    summary: 'Produkte auflisten (je Veranstaltung)',
    description:
      'Alle Produkte der Veranstaltung mit Kategorie, sortiert nach Reihenfolge und Name, seitenweise (`page`, `limit`; Standard 50). Scope `read`.',
  })
  @ApiResponse(PRODUCTS_LIST_RESPONSE)
  async findAll(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
    @Query() pagination: PaginationDto,
  ) {
    return this.productsService.findAll(eventId, user, pagination);
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get('low-stock')
  @ApiOperation({
    operationId: 'listLowStockProducts',
    summary: 'Lagerbestand-Warnungen auflisten',
    description:
      'Produkte mit Bestandsführung, deren Bestand die Warnschwelle (`lowStockThreshold`) erreicht oder unterschritten hat. Scope `read`.',
  })
  async getLowStock(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    const products = await this.productsService.getLowStock(eventId, user);
    return { data: products };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get(':productId')
  @ApiOperation({
    operationId: 'getProduct',
    summary: 'Produkt abrufen',
    description:
      'Ein Produkt der Veranstaltung mit allen Feldern. Scope `read`.',
  })
  @ApiParam({
    name: 'productId',
    description: 'ID des Produkts',
    format: 'uuid',
  })
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
  @ApiOperation({
    operationId: 'updateProduct',
    summary: 'Produkt ändern',
    description:
      'Ändert beliebige Felder eines Produkts; nicht genannte Felder bleiben. Scope `catalog:write`.',
  })
  @ApiParam({
    name: 'productId',
    description: 'ID des Produkts',
    format: 'uuid',
  })
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
  @ApiOperation({
    operationId: 'setProductAvailability',
    summary: 'Verfügbarkeit eines Produkts setzen',
    description:
      'Markiert ein Produkt als verfügbar oder ausverkauft, ohne es zu deaktivieren; die Kassen übernehmen das sofort. Scope `catalog:write`.',
  })
  @ApiParam({
    name: 'productId',
    description: 'ID des Produkts',
    format: 'uuid',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['isAvailable'],
      properties: {
        isAvailable: {
          type: 'boolean',
          description: 'true = verfügbar, false = ausverkauft',
          example: false,
        },
      },
    },
  })
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
