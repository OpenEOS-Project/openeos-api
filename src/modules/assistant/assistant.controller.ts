import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser, ApiTokenAccess } from '../../common/decorators';
import { TokenScope } from '../api-tokens/api-scopes';
import { OrganizationGuard } from '../../common/guards/organization.guard';
import { User } from '../../database/entities';
import { AssistantService } from './assistant.service';
import { IconSuggestionService } from './icon-suggestion.service';
import { IconSuggestionsDto, UpdateAssistantDto } from './dto';

@ApiTags('Assistant')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/assistant')
@UseGuards(OrganizationGuard)
export class AssistantController {
  constructor(
    private readonly assistantService: AssistantService,
    private readonly iconSuggestionService: IconSuggestionService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Status der Assistent-Funktionen',
    description:
      'enabled: Opt-in der Organisation; available: ein Modellanbieter ist auf dem Server konfiguriert; pdfSupported: der Anbieter liest PDF-Dateien (sonst nimmt der Speisekarten-Import nur Bilder); quotas: Tageskontingente (Europe/Berlin) mit limit/used/remaining/resetAt.',
  })
  @ApiResponse({
    status: 200,
    description: '{ data: { enabled, available, pdfSupported, quotas } }',
  })
  async getStatus(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.assistantService.getStatus(organizationId, user),
    };
  }

  @Patch()
  @ApiOperation({
    summary:
      'Assistent-Funktionen ein- oder ausschalten (Admin, protokolliert)',
  })
  @ApiResponse({
    status: 200,
    description: '{ data: { enabled, available, pdfSupported, quotas } }',
  })
  async setEnabled(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: UpdateAssistantDto,
    @CurrentUser() user: User,
    @Req() request: Request,
  ) {
    return {
      data: await this.assistantService.setEnabled(
        organizationId,
        dto.enabled,
        user,
        {
          ipAddress: request.ip ?? null,
          userAgent: request.headers['user-agent'] ?? null,
        },
      ),
    };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Post('icon-suggestions')
  @ApiResponse({
    status: 201,
    description:
      '{ data: [{ name, suggestions: [{ icon, score, source: lexical|model }] }] } — leeres Array, wenn kein Icon passt',
  })
  @ApiOperation({
    operationId: 'suggestProductIcons',
    summary: 'Icon-Vorschläge für Produktnamen',
    description:
      'Schlägt zu Produktnamen passende Icons aus @openeos/pos-icons vor: Stufe 1 ohne Modell (Namen und Suchbegriffe der Icons), Stufe 2 fragt bei unklaren Namen das Klassifikationsmodell. `icon` ist die Referenz `pos-icon:<id>`. Scope `read`; `404 AI_DISABLED` ohne Anbieter, `403 ASSISTANT_DISABLED` ohne Opt-in der Organisation.',
  })
  @ApiParam({
    name: 'organizationId',
    description: 'ID der Organisation',
    format: 'uuid',
  })
  async iconSuggestions(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: IconSuggestionsDto,
    @CurrentUser() user: User,
  ) {
    await this.assistantService.getStatus(organizationId, user);
    await this.assistantService.assertUsable(organizationId);
    return {
      data: await this.iconSuggestionService.suggest(
        organizationId,
        user.id,
        dto.names,
      ),
    };
  }
}
