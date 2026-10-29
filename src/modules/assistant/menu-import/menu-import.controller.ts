import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../../common/decorators';
import { OrganizationGuard } from '../../../common/guards/organization.guard';
import { User } from '../../../database/entities';
import { MenuImportService, UploadedMenuFile } from './menu-import.service';
import { ApplyMenuImportDto, CreateMenuImportDto } from './dto';

/**
 * Harte Obergrenzen fuer multer; die konfigurierten Grenzen
 * (AI_MAX_UPLOAD_MB, AI_MENU_PAGES_PER_IMPORT) prueft der Dienst mit
 * einem sprechenden Fehler. 50 MB ist das Maximum des Validierungsschemas.
 */
const MULTER_MAX_FILE_BYTES = 50 * 1024 * 1024;
const MULTER_MAX_FILES = 20;

@ApiTags('Assistant')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/events/:eventId/menu-imports')
@UseGuards(OrganizationGuard)
export class MenuImportController {
  constructor(private readonly menuImportService: MenuImportService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(
    FilesInterceptor('files', MULTER_MAX_FILES, {
      limits: { fileSize: MULTER_MAX_FILE_BYTES, files: MULTER_MAX_FILES },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Speisekarte zur Auswertung einreichen',
    description:
      'multipart: `files[]` (1–AI_MENU_PAGES_PER_IMPORT Bilder jpg/png/webp oder genau eine PDF ≤ AI_MAX_UPLOAD_MB) oder Feld `text`. Antwort 202 mit Job-ID; Status per GET pollen (alle 2 s) oder Socket-Event `menuImportUpdated { id, eventId, status }` im Organisations-Raum. Fehler: 404 AI_DISABLED, 403 ASSISTANT_DISABLED, 429 AI_QUOTA_EXCEEDED (params.resetAt), 400 MENU_IMPORT_INVALID_FILES.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
          description:
            'Bis zu AI_MENU_PAGES_PER_IMPORT Bilder (jpg/png/webp) oder genau eine PDF',
        },
        text: {
          type: 'string',
          description:
            'Alternativ zum Upload: die Speisekarte als Text (max. 20.000 Zeichen)',
        },
      },
    },
  })
  @ApiResponse({
    status: 202,
    description: "{ data: { id, status: 'queued' } }",
  })
  async create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @UploadedFiles() files: UploadedMenuFile[] | undefined,
    @Body() body: CreateMenuImportDto,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.menuImportService.create(organizationId, eventId, user, {
        files: files ?? [],
        text: body?.text,
      }),
    };
  }

  @Get()
  @ApiOperation({
    summary: 'Die letzten 20 Importe der Veranstaltung (ohne Vorschlag)',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ data: [{ id, status, source, error?, createdAt, finishedAt?, appliedAt?, usage? }] }',
  })
  async list(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.menuImportService.list(organizationId, eventId, user),
    };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Status und Vorschlag eines Imports',
    description:
      'status: queued | processing | done | failed | applied. Bei done enthält `suggestion` { categories[{ key, name, existingCategoryId? }], products[{ key, categoryKey, name, description?, price, taxRate, pfand?, variants?, existingProductId?, iconSuggestions?, confidence, note? }], warnings[] }. Bei failed steht die Ursache in `error`.',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ data: { id, status, source, error?, createdAt, finishedAt?, appliedAt?, suggestion?, usage? } }',
  })
  async findOne(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.menuImportService.findOne(
        organizationId,
        eventId,
        id,
        user,
      ),
    };
  }

  @Post(':id/apply')
  @ApiOperation({
    summary: 'Ausgewählte Kategorien und Produkte anlegen',
    description:
      'Legt Kategorien (neu oder vorhanden) und Produkte an bzw. aktualisiert sie (action create | update | skip). Varianten werden options.groups[0] (single). Danach status applied; Audit-Eintrag menu_import_applied.',
  })
  @ApiResponse({
    status: 201,
    description:
      '{ data: { createdCategories, createdProducts, updatedProducts } }',
  })
  async apply(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApplyMenuImportDto,
    @CurrentUser() user: User,
    @Req() request: Request,
  ) {
    return {
      data: await this.menuImportService.apply(
        organizationId,
        eventId,
        id,
        dto,
        user,
        {
          ipAddress: request.ip ?? null,
          userAgent: request.headers['user-agent'] ?? null,
        },
      ),
    };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Import verwerfen (löscht Dateien und Vorschlag)' })
  @ApiResponse({ status: 200, description: '{ data: { success: true } }' })
  async remove(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    await this.menuImportService.remove(organizationId, eventId, id, user);
    return { data: { success: true } };
  }
}
