import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import { ConfigService } from '@nestjs/config';
import { DeploymentService } from '../../common/services/deployment.service';
import { tseConditionsFrom } from './tse-conditions';
import { LegalAnnouncementsService } from './announcements/legal-announcements.service';

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
  constructor(
    private readonly legal: LegalService,
    private readonly deployment: DeploymentService,
    private readonly configService: ConfigService,
    private readonly announcements: LegalAnnouncementsService,
  ) {}

  @Public()
  @Get('versions')
  @ApiOperation({
    summary: 'Current legal texts (AGB, AVV, privacy, imprint)',
    description:
      'Aktuelle Fassungen (Datum der „Stand“-Zeile) mit Links auf die Website, die Archiv-Adresse der Fassung und das PDF. `enabled` ist bei eigenständigem Betrieb false — dort gelten die Texte von LUXCODE nicht. `platform`: Impressum und Datenschutz des Plattformbetreibers für öffentliche Seiten ohne Verein (z. B. Startseite des Shops); `null` = nicht anzeigen. `tseConditions`: Einsatzbedingungen der Cloud-TSE (Umgebungsschutzkonzept; `url`, `text`), nur wenn die Cloud-TSE verfügbar ist, sonst `null`.',
  })
  getVersions() {
    return {
      data: {
        ...this.legal.versions(),
        platform: this.deployment.platformLegal,
        tseConditions: tseConditionsFrom(this.configService),
      },
    };
  }

  @Get('status')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Accepted AGB/AVV versions of the current user',
    description:
      'Je Dokument die aktuelle und die zuletzt angenommene Fassung (mit Zeitpunkt und Links). `required`: Admin einer Organisation ohne Annahme der aktuellen Fassung (nur Fassungen nach der Ausgangsfassung). `change`: Ankündigung, mit der die aktuelle AGB-/AVV-Fassung kam (Zusammenfassung, Datum, ob ausdrückliche Zustimmung nötig ist), sonst `null`.',
  })
  async getStatus(@CurrentUser() user: User) {
    return { data: await this.legal.status(user.id) };
  }

  @Get('announcements')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Announced, not yet effective legal text changes',
    description:
      'Für Admins einer Organisation: angekündigte neue Fassungen, die noch nicht gelten (Datum, Dokumente, Zusammenfassung, Links auf neue und bisherige Fassung) — ohne die, die du ausgeblendet hast. Sonst eine leere Liste.',
  })
  async getAnnouncements(@CurrentUser() user: User) {
    return { data: await this.announcements.upcomingFor(user.id) };
  }

  @Post('announcements/:id/dismiss')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Hide an announcement notice for the current user',
    description: 'Blendet den Hinweis auf diese Ankündigung für dich aus.',
  })
  async dismissAnnouncement(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.announcements.dismiss(user.id, id);
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
