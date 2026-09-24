import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ApiTokensService } from './api-tokens.service';
import { CreateApiTokenDto } from './dto';
import { SuperAdminGuard } from '../../common/guards/super-admin.guard';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';

/**
 * Verwaltung der eigenen API-Tokens.
 *
 * Vorerst Super-Admins vorbehalten. Der Weg für Organisationen ist
 * derselbe, braucht aber zusätzlich einen Organisationsbezug und die
 * bestehenden Modul-Berechtigungen — das kommt, wenn es gebraucht wird.
 */
@ApiTags('API-Tokens')
@ApiBearerAuth('JWT-auth')
@Controller('admin/api-tokens')
@UseGuards(SuperAdminGuard)
export class ApiTokensController {
  constructor(private readonly apiTokensService: ApiTokensService) {}

  @Get()
  @ApiOperation({ summary: 'List your API tokens (never the secrets)' })
  async liste(@CurrentUser() user: User) {
    const data = await this.apiTokensService.liste(user.id);
    return { data };
  }

  @Post()
  @ApiOperation({
    summary: 'Issue an API token',
    description:
      'The secret is returned exactly once, here. It is stored only as a ' +
      'hash, so a lost token cannot be recovered — issue a new one.',
  })
  async erstelle(@CurrentUser() user: User, @Body() dto: CreateApiTokenDto) {
    const { token, eintrag } = await this.apiTokensService.erstelle({
      userId: user.id,
      name: dto.name,
      scopes: dto.scopes,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
    });

    return { data: { ...eintrag, token } };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Revoke a token' })
  async widerrufe(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    const data = await this.apiTokensService.widerrufe(user.id, id);
    return { data };
  }
}
