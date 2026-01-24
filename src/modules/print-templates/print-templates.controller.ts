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
import { PrintTemplatesService } from './print-templates.service';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CreatePrintTemplateDto, UpdatePrintTemplateDto } from './dto';

@ApiTags('Print Templates')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/print-templates')
export class PrintTemplatesController {
  constructor(private readonly printTemplatesService: PrintTemplatesService) {}

  @Post()
  create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() createDto: CreatePrintTemplateDto,
    @CurrentUser() user: User,
  ) {
    return this.printTemplatesService.create(organizationId, createDto, user);
  }

  @Get()
  findAll(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() pagination: PaginationDto,
    @CurrentUser() user: User,
  ) {
    return this.printTemplatesService.findAll(organizationId, user, pagination);
  }

  @Get(':templateId')
  findOne(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @CurrentUser() user: User,
  ) {
    return this.printTemplatesService.findOne(organizationId, templateId, user);
  }

  @Patch(':templateId')
  update(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Body() updateDto: UpdatePrintTemplateDto,
    @CurrentUser() user: User,
  ) {
    return this.printTemplatesService.update(organizationId, templateId, updateDto, user);
  }

  @Delete(':templateId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @CurrentUser() user: User,
  ) {
    return this.printTemplatesService.remove(organizationId, templateId, user);
  }

  @Post(':templateId/preview')
  @HttpCode(HttpStatus.OK)
  preview(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @CurrentUser() user: User,
  ) {
    return this.printTemplatesService.preview(organizationId, templateId, user);
  }
}
