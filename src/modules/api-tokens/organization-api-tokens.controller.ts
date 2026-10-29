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
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/api-tokens')
@UseGuards(OrganizationGuard, RolesGuard)
@Roles(Role.ADMIN)
export class OrganizationApiTokensController {
  constructor(private readonly apiTokensService: ApiTokensService) {}

  @Get()
  @ApiOperation({
    summary: 'List the organization’s API tokens (never the secrets)',
    description:
      'All tokens of the organization, including revoked and expired ' +
      'ones, newest first. `tokenPrefix` is the only part of the secret ' +
      'that is ever shown again.',
  })
  @ApiParam({ name: 'organizationId', format: 'uuid' })
  async list(@Param('organizationId', ParseUUIDPipe) organizationId: string) {
    const data = await this.apiTokensService.listeOrganisation(organizationId);
    return { data };
  }

  @Post()
  @ApiOperation({
    summary: 'Issue an API token',
    description:
      'The secret (`token`, `oeos_…`) is returned exactly once, here. It is ' +
      'stored only as a SHA-256 hash, so a lost token cannot be recovered — ' +
      'revoke it and issue a new one. At most 20 active tokens per ' +
      'organization (409 `API_TOKEN_LIMIT_REACHED`).',
  })
  @ApiParam({ name: 'organizationId', format: 'uuid' })
  @ApiResponse({
    status: 201,
    description: 'Token issued; `data.token` holds the secret',
  })
  @ApiResponse({ status: 409, description: 'API_TOKEN_LIMIT_REACHED' })
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
  @ApiOperation({
    summary: 'Revoke a token',
    description:
      'Revoked, not deleted: the entry stays in the list with `revokedAt` ' +
      'set. Any admin of the organization may revoke any of its tokens.',
  })
  @ApiParam({ name: 'organizationId', format: 'uuid' })
  @ApiParam({ name: 'id', format: 'uuid' })
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
