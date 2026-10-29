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
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
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
@ApiBearerAuth('JWT-auth')
@Controller('events/:eventId/categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @ApiTokenAccess(TokenScope.CATALOG_WRITE)
  @Post()
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
  async findAll(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    const categories = await this.categoriesService.findAll(eventId, user);
    return { data: categories };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get(':categoryId')
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
