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
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { PrintTemplatesService } from './print-templates.service';
import { CurrentUser, ApiTokenAccess } from '../../common/decorators';
import { TokenScope } from '../api-tokens/api-scopes';
import { User } from '../../database/entities';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CreatePrintTemplateDto, UpdatePrintTemplateDto } from './dto';

@ApiTags('Print Templates')
@ApiParam({
  name: 'organizationId',
  description: 'ID der Organisation',
  format: 'uuid',
})
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/print-templates')
export class PrintTemplatesController {
  constructor(private readonly printTemplatesService: PrintTemplatesService) {}

  @ApiTokenAccess(TokenScope.DEVICES_WRITE)
  @Post()
  @ApiOperation({
    operationId: 'createPrintTemplate',
    summary: 'Bon-Vorlage anlegen',
    description:
      'Legt eine Vorlage für Bons oder Bestellzettel an. Scope `devices:write` und Modulrecht Geräte.',
  })
  create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() createDto: CreatePrintTemplateDto,
    @CurrentUser() user: User,
  ) {
    return this.printTemplatesService.create(organizationId, createDto, user);
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get()
  @ApiOperation({
    operationId: 'listPrintTemplates',
    summary: 'Bon-Vorlagen auflisten',
    description:
      'Alle Bon-Vorlagen der Organisation, seitenweise (`page`, `limit`). Scope `read`.',
  })
  findAll(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() pagination: PaginationDto,
    @CurrentUser() user: User,
  ) {
    return this.printTemplatesService.findAll(organizationId, user, pagination);
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get(':templateId')
  @ApiOperation({
    operationId: 'getPrintTemplate',
    summary: 'Bon-Vorlage abrufen',
    description: 'Eine Bon-Vorlage mit ihrer Definition. Scope `read`.',
  })
  @ApiParam({
    name: 'templateId',
    description: 'ID der Vorlage',
    format: 'uuid',
  })
  findOne(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @CurrentUser() user: User,
  ) {
    return this.printTemplatesService.findOne(organizationId, templateId, user);
  }

  @ApiTokenAccess(TokenScope.DEVICES_WRITE)
  @Patch(':templateId')
  @ApiOperation({
    operationId: 'updatePrintTemplate',
    summary: 'Bon-Vorlage ändern',
    description:
      'Ändert Name, Typ oder Definition einer Vorlage. Scope `devices:write`.',
  })
  @ApiParam({
    name: 'templateId',
    description: 'ID der Vorlage',
    format: 'uuid',
  })
  update(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Body() updateDto: UpdatePrintTemplateDto,
    @CurrentUser() user: User,
  ) {
    return this.printTemplatesService.update(
      organizationId,
      templateId,
      updateDto,
      user,
    );
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

  @ApiTokenAccess(TokenScope.READ)
  @Post(':templateId/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'previewPrintTemplate',
    summary: 'Bon-Vorlage als Vorschau rendern',
    description:
      'Rendert die Vorlage mit Beispieldaten und liefert das Ergebnis als HTML (`data.html`), ohne zu drucken. Scope `read`.',
  })
  @ApiParam({
    name: 'templateId',
    description: 'ID der Vorlage',
    format: 'uuid',
  })
  preview(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @CurrentUser() user: User,
  ) {
    return this.printTemplatesService.preview(organizationId, templateId, user);
  }
}
