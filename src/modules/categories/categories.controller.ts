import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CategoriesService } from './categories.service';
import {
  CreateCategoryDto,
  UpdateCategoryDto,
  ReorderCategoriesDto,
} from './dto';
import { CurrentUser, ApiTokenAccess } from '../../common/decorators';
import { TokenScope } from '../api-tokens/api-scopes';
import { User } from '../../database/entities';

@ApiTags('Categories')
@ApiParam({
  name: 'eventId',
  description: 'ID der Veranstaltung',
  format: 'uuid',
})
@ApiBearerAuth('JWT-auth')
@Controller('events/:eventId/categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @ApiTokenAccess(TokenScope.CATALOG_WRITE)
  @Post()
  @ApiOperation({
    operationId: 'createCategory',
    summary: 'Kategorie anlegen',
    description:
      'Legt eine Kategorie in der Veranstaltung an. Scope `catalog:write` und Modulrecht Produkte.',
  })
  async create(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() createDto: CreateCategoryDto,
    @CurrentUser() user: User,
  ) {
    const category = await this.categoriesService.create(
      eventId,
      createDto,
      user,
    );
    return { data: category };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get()
  @ApiOperation({
    operationId: 'listCategories',
    summary: 'Kategorien auflisten (je Veranstaltung)',
    description:
      'Alle Kategorien der Veranstaltung in ihrer Sortierreihenfolge, ohne Seitenwechsel. Scope `read`.',
  })
  async findAll(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    const categories = await this.categoriesService.findAll(eventId, user);
    return { data: categories };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get(':categoryId')
  @ApiOperation({
    operationId: 'getCategory',
    summary: 'Kategorie abrufen',
    description: 'Eine Kategorie der Veranstaltung. Scope `read`.',
  })
  @ApiParam({
    name: 'categoryId',
    description: 'ID der Kategorie',
    format: 'uuid',
  })
  async findOne(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
    @CurrentUser() user: User,
  ) {
    const category = await this.categoriesService.findOne(
      eventId,
      categoryId,
      user,
    );
    return { data: category };
  }

  /* Muss vor @Patch(':categoryId') stehen. Express prueft die Routen in
     der Reihenfolge ihrer Deklaration, und 'reorder' passt auch auf den
     Platzhalter — stand sie danach, landete der Aufruf im Bearbeiten-
     Handler mit categoryId = "reorder" und scheiterte an der UUID-Pruefung.
     Genau das ist passiert, die Route war nie erreichbar. */
  @ApiTokenAccess(TokenScope.CATALOG_WRITE)
  @Patch('reorder')
  @ApiOperation({
    operationId: 'reorderCategories',
    summary: 'Kategorien sortieren',
    description:
      'Setzt die Reihenfolge aller Kategorien anhand der übergebenen ID-Liste. Scope `catalog:write`.',
  })
  async reorder(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() reorderDto: ReorderCategoriesDto,
    @CurrentUser() user: User,
  ) {
    await this.categoriesService.reorder(eventId, reorderDto, user);
    return { message: 'Kategorien neu sortiert' };
  }

  @ApiTokenAccess(TokenScope.CATALOG_WRITE)
  @Patch(':categoryId')
  @ApiOperation({
    operationId: 'updateCategory',
    summary: 'Kategorie ändern',
    description:
      'Ändert Name, Farbe, Icon oder Sichtbarkeit einer Kategorie. Scope `catalog:write`.',
  })
  @ApiParam({
    name: 'categoryId',
    description: 'ID der Kategorie',
    format: 'uuid',
  })
  async update(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
    @Body() updateDto: UpdateCategoryDto,
    @CurrentUser() user: User,
  ) {
    const category = await this.categoriesService.update(
      eventId,
      categoryId,
      updateDto,
      user,
    );
    return { data: category };
  }

  @Delete(':categoryId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
    @CurrentUser() user: User,
  ) {
    await this.categoriesService.remove(eventId, categoryId, user);
  }
}
