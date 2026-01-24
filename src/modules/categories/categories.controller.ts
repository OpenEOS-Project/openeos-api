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
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto, UpdateCategoryDto, ReorderCategoriesDto } from './dto';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';

@ApiTags('Categories')
@ApiBearerAuth('JWT-auth')
@Controller('events/:eventId/categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Post()
  async create(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() createDto: CreateCategoryDto,
    @CurrentUser() user: User,
  ) {
    const category = await this.categoriesService.create(eventId, createDto, user);
    return { data: category };
  }

  @Get()
  async findAll(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    const categories = await this.categoriesService.findAll(eventId, user);
    return { data: categories };
  }

  @Get(':categoryId')
  async findOne(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
    @CurrentUser() user: User,
  ) {
    const category = await this.categoriesService.findOne(eventId, categoryId, user);
    return { data: category };
  }

  @Patch(':categoryId')
  async update(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
    @Body() updateDto: UpdateCategoryDto,
    @CurrentUser() user: User,
  ) {
    const category = await this.categoriesService.update(eventId, categoryId, updateDto, user);
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

  @Patch('reorder')
  async reorder(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() reorderDto: ReorderCategoriesDto,
    @CurrentUser() user: User,
  ) {
    await this.categoriesService.reorder(eventId, reorderDto, user);
    return { message: 'Kategorien neu sortiert' };
  }
}
