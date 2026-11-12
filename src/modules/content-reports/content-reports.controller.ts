import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../common/decorators/public.decorator';
import {
  CurrentUser,
  type RequestUser,
} from '../../common/decorators/current-user.decorator';
import { SuperAdminGuard } from '../../common/guards/super-admin.guard';
import {
  CONTENT_REPORT_STATUSES,
  type ContentReportStatus,
} from '../../database/entities/content-report.entity';
import { ContentReportsService } from './content-reports.service';
import {
  CreateContentReportDto,
  NotifyContentReportDto,
  UpdateContentReportDto,
} from './dto';

@ApiTags('Content reports (Public)')
@Controller('public/content-reports')
@Public()
export class ContentReportsController {
  constructor(private readonly service: ContentReportsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 3600000 } })
  @ApiOperation({
    summary: 'Report illegal content on a public page (Art. 16 DSA)',
    description:
      'Meldung eines rechtswidrigen Inhalts in einem Vereins-Shop oder auf einer Helferseite (Melde- und Abhilfeverfahren nach Art. 16 DSA). Nicht authentifiziert; Honeypot, Mindest-Ausfüllzeit, höchstens 5 Meldungen je Stunde und IP-Adresse. Der Meldende erhält eine Eingangsbestätigung per E-Mail.',
  })
  async submit(@Body() dto: CreateContentReportDto) {
    return { data: await this.service.submit(dto) };
  }
}

@ApiTags('Admin — Inhaltsmeldungen')
@ApiBearerAuth('JWT-auth')
@Controller('admin/content-reports')
@UseGuards(SuperAdminGuard)
export class ContentReportsAdminController {
  constructor(private readonly service: ContentReportsService) {}

  @Get()
  @ApiOperation({ summary: 'List content reports (DSA), newest first' })
  async list(@Query('status') status?: string) {
    const filter = (CONTENT_REPORT_STATUSES as readonly string[]).includes(
      status ?? '',
    )
      ? (status as ContentReportStatus)
      : undefined;
    return { data: await this.service.list({ status: filter }) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one content report' })
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.service.get(id) };
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update status, decision and statement of reasons',
    description:
      'Status (open/in_review/closed), Maßnahme (none/hide_content/disable_shop), Entscheidung, Sachverhalt, Grundlage und Rechtsbehelfe. `disable_shop` schaltet den Shop der Veranstaltung ab bzw. nimmt die Helferseite aus der Veröffentlichung (einmalig).',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateContentReportDto,
    @CurrentUser() user: RequestUser,
  ) {
    return { data: await this.service.update(id, dto, user.id) };
  }

  @Post(':id/notify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Send the decision to the reporter or the statement of reasons to the club',
    description:
      '`reporter`: Mitteilung der Entscheidung an den Meldenden (Art. 16 Abs. 5 DSA). `organization`: Begründung an die Admins des Vereins (Art. 17 DSA) mit Maßnahme, Sachverhalt, Grundlage und Rechtsbehelfen.',
  })
  async notify(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: NotifyContentReportDto,
  ) {
    return { data: await this.service.notify(id, dto.target) };
  }
}
