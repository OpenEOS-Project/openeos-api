import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { SaasOnly } from '../../../common/decorators/saas-only.decorator';
import { SuperAdminGuard } from '../../../common/guards/super-admin.guard';
import type { User } from '../../../database/entities';
import { LegalAnnouncementDto } from './dto';
import { LegalAnnouncementMailer } from './legal-announcement-mailer.service';
import { LegalAnnouncementsService } from './legal-announcements.service';

/** Neue Fassungen der Rechtstexte ankündigen (Super-Admin). */
@ApiTags('Admin')
@ApiBearerAuth('JWT-auth')
@Controller('admin/legal-announcements')
@UseGuards(SuperAdminGuard)
@SaasOnly()
export class LegalAnnouncementsAdminController {
  constructor(
    private readonly announcements: LegalAnnouncementsService,
    private readonly mailer: LegalAnnouncementMailer,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Legal text announcements with delivery status',
    description:
      'Geltende Fassungen, Ausgangsfassung, frühestes Datum für AGB/AVV (sechs Wochen), Zahl der Empfänger und alle Ankündigungen mit Versandstand (gesendet, offen, gescheitert).',
  })
  async overview() {
    return { data: await this.announcements.overview() };
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Validate an announcement and render its e-mail',
    description:
      'Prüft Frist, Reihenfolge und ob die neue Fassung auf der Website abrufbar ist, und liefert Betreff und HTML der Mail (an dich adressiert) sowie die Zahl der Empfänger. Speichert nichts.',
  })
  async preview(@Body() dto: LegalAnnouncementDto, @CurrentUser() user: User) {
    return { data: await this.announcements.preview(dto, user) };
  }

  @Post()
  @ApiOperation({
    summary: 'Announce a new version of the legal texts',
    description:
      'Speichert die Ankündigung und verschickt die Mail an alle Admins aller Organisationen (je Adresse einmal, im Hintergrund). Ab dem Datum gilt die neue Fassung. Bei Fehlern 400 mit `details`.',
  })
  async create(@Body() dto: LegalAnnouncementDto, @CurrentUser() user: User) {
    const created = await this.announcements.create(dto, user);
    this.mailer.kick();
    return { data: created };
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Queue failed announcement e-mails again',
    description:
      'Reiht die gescheiterten Mails einer Ankündigung erneut ein. Achtung: Bei „Versand unterbrochen“ kann die Mail schon angekommen sein.',
  })
  async retry(@Param('id', ParseUUIDPipe) id: string) {
    const queued = await this.announcements.retryFailed(id);
    if (queued) this.mailer.kick();
    return { data: { queued } };
  }
}
