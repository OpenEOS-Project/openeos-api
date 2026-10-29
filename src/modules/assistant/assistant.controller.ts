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
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators';
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
      'enabled: Opt-in der Organisation; available: ein Modellanbieter ist auf dem Server konfiguriert; quotas: Tageskontingente (Europe/Berlin) mit limit/used/remaining/resetAt.',
  })
  @ApiResponse({
    status: 200,
    description: '{ data: { enabled, available, quotas } }',
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
    description: '{ data: { enabled, available, quotas } }',
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

  @Post('icon-suggestions')
  @ApiOperation({
    summary: 'Icon-Vorschläge aus @openeos/pos-icons für Produktnamen',
    description:
      'Stufe 1 ohne Modell (Namen/Suchbegriffe der Icons), Stufe 2 fragt bei unklaren Namen das Klassifikationsmodell (Kontingent classifications). icon ist die Referenz `pos-icon:<id>`. 404 AI_DISABLED ohne Anbieter, 403 ASSISTANT_DISABLED ohne Opt-in.',
  })
  @ApiResponse({
    status: 201,
    description: '{ data: [{ name, suggestions: [{ icon, score }] }] }',
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
