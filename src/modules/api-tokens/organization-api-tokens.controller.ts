import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
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

import { ApiTokensService } from './api-tokens.service';
import { CreateOrganizationApiTokenDto } from './dto';
import { CurrentUser, Roles } from '../../common/decorators';
import { OrganizationGuard, RolesGuard } from '../../common/guards';
import { Role } from '../../common/constants/roles.enum';
import { User } from '../../database/entities';

/**
 * API-Tokens einer Organisation — für Skripte, Zapier und KI-Agenten
 * (MCP). Nur Organisations-Admins, nur mit Anmeldung (JWT): ein Token
 * kann keine weiteren Tokens ausstellen, sonst ließe sich eine
 * Einschränkung durch einen neuen Token aufheben.
 */
@ApiTags('API Tokens')
@ApiParam({
  name: 'organizationId',
  description: 'ID der Organisation',
  format: 'uuid',
})
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/api-tokens')
@UseGuards(OrganizationGuard, RolesGuard)
@Roles(Role.ADMIN)
export class OrganizationApiTokensController {
  constructor(private readonly apiTokensService: ApiTokensService) {}

  @Get()
  @ApiOperation({
    operationId: 'listApiTokens',
    summary: 'API-Zugänge auflisten',
    description:
      'Alle Tokens der Organisation, auch widerrufene und abgelaufene, neueste zuerst. Vom Geheimnis bleibt nur `tokenPrefix` sichtbar. Nur mit Anmeldung (JWT) als Administrator — nicht per Token.',
  })
  async list(@Param('organizationId', ParseUUIDPipe) organizationId: string) {
    const data = await this.apiTokensService.listeOrganisation(organizationId);
    return { data };
  }

  @Post()
  @ApiResponse({
    status: 201,
    description: 'Token issued; `data.token` holds the secret',
  })
  @ApiResponse({ status: 409, description: 'API_TOKEN_LIMIT_REACHED' })
  @ApiOperation({
    operationId: 'createApiToken',
    summary: 'API-Zugang anlegen',
    description:
      'Stellt einen Token mit Name, Scopes und optionalem Ablauf aus. Das Geheimnis (`data.token`, `oeos_…`) kommt genau einmal in dieser Antwort; gespeichert wird nur ein Hash. Höchstens 20 aktive Tokens je Organisation (`409 API_TOKEN_LIMIT_REACHED`). Nur mit Anmeldung als Administrator.',
  })
  async create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() user: User,
    @Body() dto: CreateOrganizationApiTokenDto,
    @Req() request: Request,
  ) {
    const { token, eintrag } = await this.apiTokensService.erstelle({
      userId: user.id,
      organizationId,
      name: dto.name,
      scopes: dto.scopes,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      client: {
        ipAddress: request.ip ?? null,
        userAgent: request.headers['user-agent'] ?? null,
      },
    });

    return { data: { ...eintrag, token } };
  }

  @Delete(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    operationId: 'revokeApiToken',
    summary: 'API-Zugang widerrufen',
    description:
      'Widerruft einen Token sofort; der Eintrag bleibt mit `revokedAt` in der Liste. Jeder Administrator der Organisation darf jeden Token der Organisation widerrufen. Nur mit Anmeldung.',
  })
  @ApiParam({ name: 'id', description: 'ID des Tokens', format: 'uuid' })
  async revoke(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
    @Req() request: Request,
  ) {
    const data = await this.apiTokensService.widerrufeOrganisation(
      organizationId,
      id,
      user,
      {
        ipAddress: request.ip ?? null,
        userAgent: request.headers['user-agent'] ?? null,
      },
    );
    return { data };
  }
}
