import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { User } from '../../database/entities';
import { AcceptLegalDto } from './dto';
import { LegalService } from './legal.service';

export function clientOf(request: Request): {
  ip?: string;
  userAgent?: string;
} {
  const userAgent = request.headers['user-agent'];
  return {
    ip: request.ip || request.socket?.remoteAddress,
    userAgent: typeof userAgent === 'string' ? userAgent : undefined,
  };
}

@ApiTags('Legal')
@Controller('legal')
export class LegalController {
  constructor(private readonly legal: LegalService) {}

  @Public()
  @Get('versions')
  @ApiOperation({
    summary: 'Current legal texts (AGB, AVV, privacy, imprint)',
    description:
      'Aktuelle Fassungen (Datum der „Stand“-Zeile) mit Links auf die Website, die Archiv-Adresse der Fassung und das PDF. `enabled` ist bei eigenständigem Betrieb false — dort gelten die Texte von LUXCODE nicht.',
  })
  getVersions() {
    return { data: this.legal.versions() };
  }

  @Get('status')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Accepted AGB/AVV versions of the current user',
    description:
      'Je Dokument die aktuelle und die zuletzt angenommene Fassung (mit Zeitpunkt und Links). `required`: Admin einer Organisation ohne Annahme der aktuellen Fassung.',
  })
  async getStatus(@CurrentUser() user: User) {
    return { data: await this.legal.status(user.id) };
  }

  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Accept the current AGB/AVV versions',
    description:
      'Speichert die Annahme der aktuellen Fassungen mit Zeitpunkt, IP-Adresse und Browser. Antwort wie GET /legal/status.',
  })
  async accept(
    @CurrentUser() user: User,
    @Body() dto: AcceptLegalDto,
    @Req() request: Request,
  ) {
    return {
      data: await this.legal.accept(user, dto, clientOf(request)),
    };
  }
}
