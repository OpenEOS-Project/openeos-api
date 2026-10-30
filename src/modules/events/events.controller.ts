import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { EventsService } from './events.service';
import { CreateEventDto, UpdateEventDto, CopyProductsDto } from './dto';
import { CurrentUser, ApiTokenAccess } from '../../common/decorators';
import { TokenScope } from '../api-tokens/api-scopes';
import { User } from '../../database/entities';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { EVENTS_LIST_RESPONSE } from './events.openapi';

@ApiTags('Events')
@ApiParam({
  name: 'organizationId',
  description: 'ID der Organisation',
  format: 'uuid',
})
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @ApiTokenAccess(TokenScope.EVENTS_WRITE)
  @Post()
  @ApiOperation({
    operationId: 'createEvent',
    summary: 'Veranstaltung anlegen',
    description:
      'Legt eine neue Veranstaltung mit Status `inactive` an. Scope `events:write` und Modulrecht Veranstaltungen; freischalten und aktivieren geht nur in der App.',
  })
  async create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() createDto: CreateEventDto,
    @CurrentUser() user: User,
  ) {
    const event = await this.eventsService.create(
      organizationId,
      createDto,
      user,
    );
    return { data: event };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get()
  @ApiOperation({
    operationId: 'listEvents',
    summary: 'Veranstaltungen auflisten',
    description:
      'Alle Veranstaltungen der Organisation, neueste zuerst, seitenweise (`page`, `limit`). Scope `read`.',
  })
  @ApiResponse(EVENTS_LIST_RESPONSE)
  async findAll(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() user: User,
    @Query() pagination: PaginationDto,
  ) {
    return this.eventsService.findAll(organizationId, user, pagination);
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get('active')
  @ApiOperation({
    operationId: 'getActiveEvent',
    summary: 'Aktive Veranstaltung abrufen',
    description:
      'Liefert die Veranstaltung mit Status `active` oder `test` — oder `data: null`, wenn gerade keine läuft. Scope `read`.',
  })
  async findActive(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() user: User,
  ) {
    const event = await this.eventsService.getActiveOrTestForUser(
      organizationId,
      user,
    );
    return { data: event };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get(':eventId')
  @ApiOperation({
    operationId: 'getEvent',
    summary: 'Veranstaltung abrufen',
    description:
      'Eine Veranstaltung mit Einstellungen und Abrechnungsstand. Scope `read`.',
  })
  @ApiParam({
    name: 'eventId',
    description: 'ID der Veranstaltung',
    format: 'uuid',
  })
  async findOne(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    const event = await this.eventsService.findOne(
      organizationId,
      eventId,
      user,
    );
    return { data: event };
  }

  @ApiTokenAccess(TokenScope.EVENTS_WRITE)
  @Patch(':eventId')
  @ApiOperation({
    operationId: 'updateEvent',
    summary: 'Veranstaltung ändern',
    description:
      'Ändert Name, Beschreibung, Zeitraum oder Einstellungen. Scope `events:write`; der Status (aktiv, Test) lässt sich hier nicht setzen.',
  })
  @ApiParam({
    name: 'eventId',
    description: 'ID der Veranstaltung',
    format: 'uuid',
  })
  async update(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() updateDto: UpdateEventDto,
    @CurrentUser() user: User,
  ) {
    const event = await this.eventsService.update(
      organizationId,
      eventId,
      updateDto,
      user,
    );
    return { data: event };
  }

  @Delete(':eventId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    await this.eventsService.remove(organizationId, eventId, user);
  }

  // Event Lifecycle
  @Post(':eventId/activate')
  @ApiOperation({
    summary:
      'Aktiviert ein Event (deaktiviert das aktuell aktive Event der Organisation, löscht die im Testmodus entstandenen Bestellungen)',
  })
  async activate(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    const event = await this.eventsService.activate(
      organizationId,
      eventId,
      user,
    );
    return { data: event };
  }

  @Post(':eventId/deactivate')
  @ApiOperation({ summary: 'Deaktiviert ein Event' })
  async deactivate(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    const event = await this.eventsService.deactivate(
      organizationId,
      eventId,
      user,
    );
    return { data: event };
  }

  @Post(':eventId/test')
  @ApiOperation({
    summary:
      'Setzt ein Event in den Test-Modus (Bestellungen werden als Test markiert)',
  })
  async setTestMode(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    const event = await this.eventsService.setTestMode(
      organizationId,
      eventId,
      user,
    );
    return { data: event };
  }

  // Copy products from another event
  @ApiTokenAccess(TokenScope.EVENTS_WRITE)
  @Post(':eventId/copy-from/:sourceEventId')
  @ApiOperation({
    operationId: 'copyEventCatalog',
    summary: 'Katalog aus anderer Veranstaltung kopieren',
    description:
      'Kopiert Kategorien und Produkte aus `sourceEventId` in diese Veranstaltung; was übernommen wird, steuert der Body. Scope `events:write`.',
  })
  @ApiParam({
    name: 'eventId',
    description: 'ID der Ziel-Veranstaltung',
    format: 'uuid',
  })
  @ApiParam({
    name: 'sourceEventId',
    description: 'ID der Veranstaltung, aus der kopiert wird',
    format: 'uuid',
  })
  async copyFromEvent(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('sourceEventId', ParseUUIDPipe) sourceEventId: string,
    @Body() copyDto: CopyProductsDto,
    @CurrentUser() user: User,
  ) {
    const result = await this.eventsService.copyFromEvent(
      organizationId,
      eventId,
      sourceEventId,
      copyDto,
      user,
    );
    return { data: result };
  }
}
