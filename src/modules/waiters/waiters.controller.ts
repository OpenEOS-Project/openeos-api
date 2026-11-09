import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';
import {
  BulkCreateWaitersDto,
  CreateWaiterDto,
  ResetWaiterPinDto,
  UpdateWaiterDto,
} from './dto/waiter.dto';
import { WaitersService, type RequestMeta } from './waiters.service';

function metaOf(req: Request): RequestMeta {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  };
}

/**
 * Bedienungen verwalten (bedienungen-plan.md §5): Admin oder Recht
 * „Bedienungen“. Bewusst ohne API-Token/MCP (keine Personendaten des
 * Kassenpersonals ueber Agenten, Entscheidung 14).
 */
@ApiTags('Waiters')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:id/waiters')
export class WaitersController {
  constructor(private readonly waiters: WaitersService) {}

  @Get()
  @ApiOperation({
    summary: 'Bedienungen der Organisation (ohne PIN)',
    description:
      '`eventId`: Bedienungen dieser Veranstaltung plus die organisationsweiten. `active=true|false` filtert. `meta.limit`/`meta.count`: Obergrenze (0 = unbegrenzt) und angelegte Bedienungen; Bedienungen zählen nicht zu den Mitgliedern.',
  })
  @ApiQuery({ name: 'eventId', required: false })
  @ApiQuery({ name: 'active', required: false, enum: ['true', 'false'] })
  list(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
    @Query('eventId', new ParseUUIDPipe({ optional: true })) eventId?: string,
    @Query('active') active?: string,
  ) {
    return this.waiters.list(id, user, {
      eventId: eventId ?? null,
      active: active === 'true' ? true : active === 'false' ? false : null,
    });
  }

  @Post()
  @ApiOperation({
    summary: 'Bedienung anlegen',
    description:
      'Ohne `pin` erzeugt das System eine eindeutige PIN (Länge laut `settings.waiters.pinLength`, Standard 4). Die Antwort enthält die PIN **einmalig**; gespeichert wird nur ein Prüfwert. Eigene PIN: einfache Folgen und vergebene PINs → 400 PIN_NOT_AVAILABLE. Obergrenze: 400 WAITER_LIMIT_REACHED.',
  })
  async create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateWaiterDto,
    @CurrentUser() user: User,
    @Req() req: Request,
  ) {
    return { data: await this.waiters.create(id, dto, user, metaOf(req)) };
  }

  @Post('bulk')
  @ApiOperation({
    summary: 'Bedienungen in einem Schritt anlegen (bis 200)',
    description:
      'Namensliste je Veranstaltung (`eventId`) oder organisationsweit. Alle bekommen eine erzeugte PIN; die Antwort enthält sie **einmalig** (PIN-Zettel). Alles oder nichts.',
  })
  async bulk(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BulkCreateWaitersDto,
    @CurrentUser() user: User,
    @Req() req: Request,
  ) {
    return { data: await this.waiters.bulkCreate(id, dto, user, metaOf(req)) };
  }

  @Get(':waiterId')
  @ApiOperation({ summary: 'Eine Bedienung (ohne PIN)' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('waiterId', ParseUUIDPipe) waiterId: string,
    @CurrentUser() user: User,
  ) {
    return { data: await this.waiters.findOne(id, waiterId, user) };
  }

  @Patch(':waiterId')
  @ApiOperation({
    summary: 'Bedienung ändern',
    description:
      'Name, Kurzname, Farbe, Rolle, Rechte, Veranstaltung, aktiv. Deaktivieren löscht die PIN und beendet offene Sitzungen (Kasse sperrt).',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('waiterId', ParseUUIDPipe) waiterId: string,
    @Body() dto: UpdateWaiterDto,
    @CurrentUser() user: User,
    @Req() req: Request,
  ) {
    return {
      data: await this.waiters.update(id, waiterId, dto, user, metaOf(req)),
    };
  }

  @Post(':waiterId/pin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Neue PIN vergeben',
    description:
      'Erzeugt eine neue PIN (oder setzt die gewählte) und beendet offene Sitzungen. Die Antwort enthält die PIN **einmalig**.',
  })
  async resetPin(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('waiterId', ParseUUIDPipe) waiterId: string,
    @Body() dto: ResetWaiterPinDto,
    @CurrentUser() user: User,
    @Req() req: Request,
  ) {
    return {
      data: await this.waiters.resetPin(
        id,
        waiterId,
        dto.pin,
        user,
        metaOf(req),
      ),
    };
  }

  @Delete(':waiterId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bedienung löschen',
    description:
      'Ohne Buchungen wird sie gelöscht (`deleted: true`). Mit Buchungen wird sie deaktiviert und anonymisiert (`anonymized: true`, Name „Bedienung N“); das Steuerarchiv behält den Namen beim Signieren.',
  })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('waiterId', ParseUUIDPipe) waiterId: string,
    @CurrentUser() user: User,
    @Req() req: Request,
  ) {
    return { data: await this.waiters.remove(id, waiterId, user, metaOf(req)) };
  }
}
