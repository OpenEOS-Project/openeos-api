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
import {
  CreateEventDto,
  UpdateEventDto,
  CopyProductsDto,
  DuplicateEventDto,
} from './dto';
import { CurrentUser, ApiTokenAccess } from '../../common/decorators';
import { TokenScope } from '../api-tokens/api-scopes';
import { User } from '../../database/entities';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { EVENTS_LIST_RESPONSE } from './events.openapi';
import { EventPhaseService } from './event-phase.service';

@ApiTags('Events')
@ApiParam({
  name: 'organizationId',
  description: 'ID der Organisation',
  format: 'uuid',
})
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/events')
export class EventsController {
  constructor(
    private readonly eventsService: EventsService,
    private readonly eventPhase: EventPhaseService,
  ) {}

  @ApiTokenAccess(TokenScope.EVENTS_WRITE)
  @Post()
  @ApiOperation({
    operationId: 'createEvent',
    summary: 'Veranstaltung anlegen',
    description:
      'Legt eine neue Veranstaltung mit Status `inactive` an. Scope `events:write` und Modulrecht Veranstaltungen; freischalten und aktivieren geht nur in der App. Mit `copyFromEventId` übernimmt sie Kategorien, Produkte und Produktionsstationen jener Veranstaltung in derselben Transaktion (Zusammenfassung in `copySummary`); ohne Angabe oder mit `null` bleibt sie leer. Dieselbe Vorlage mit gleichem Namen und Beginn binnen 30 Sekunden ein zweites Mal → 409 `EVENT_COPY_IN_PROGRESS`.',
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
    return { data: await this.eventPhase.decorate(event) };
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
    const result = await this.eventsService.findAll(
      organizationId,
      user,
      pagination,
    );
    return {
      ...result,
      data: await this.eventPhase.decorateMany(result.data),
    };
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
    return { data: await this.eventPhase.decorate(event) };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get(':eventId')
  @ApiOperation({
    operationId: 'getEvent',
    summary: 'Veranstaltung abrufen',
    description:
      'Eine Veranstaltung mit Einstellungen und Abrechnungsstand. Dazu die abgeleitete Phase: `phase` (`inactive`, `test`, `planned` = freigeschaltet, vor dem Verkaufsfenster – Kasse bucht Testbestellungen –, `active`, `ended` = keine neuen Bestellungen), `realSalesFrom`/`realSalesUntil` (Verkaufsfenster samt Vorlauf und Kulanz), `presaleEnabled` und `phaseDetails`. Scope `read`.',
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
    return { data: await this.eventPhase.decorate(event) };
  }

  @ApiTokenAccess(TokenScope.EVENTS_WRITE)
  @Patch(':eventId')
  @ApiOperation({
    operationId: 'updateEvent',
    summary: 'Veranstaltung ändern',
    description:
      'Ändert Name, Beschreibung, Zeitraum oder Einstellungen. Scope `events:write`; der Status (aktiv, Test) lässt sich hier nicht setzen. Freigeschaltete Veranstaltungen lassen sich nur verschieben, solange sie „Geplant“ sind (`phase: planned`); danach ist der Beginn fest und das Ende kann nur noch vorgezogen werden (400 `EVENT_DATES_LOCKED`). `settings.sales`: `earlyStartHours` (Vorlauf vor dem ersten Geschäftstag, 0 bis `EVENT_EARLY_START_MAX_HOURS`, Standard `EVENT_EARLY_START_HOURS`) und `presale` (Vorverkauf im Shop schon vor dem Verkaufsfenster).',
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
    return { data: await this.eventPhase.decorate(event) };
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
    return { data: await this.eventPhase.decorate(event) };
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
    return { data: await this.eventPhase.decorate(event) };
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
    return { data: await this.eventPhase.decorate(event) };
  }

  // Copy products from another event
  @ApiTokenAccess(TokenScope.EVENTS_WRITE)
  @Post(':eventId/copy-from/:sourceEventId')
  @ApiOperation({
    operationId: 'copyEventCatalog',
    summary: 'Katalog aus anderer Veranstaltung kopieren',
    description:
      'Übernimmt Kategorien und Produkte aus `sourceEventId` in diese Veranstaltung samt der Produktionsstationen, auf die sie zeigen; was übernommen wird, steuert der Body (ohne Auswahl alles). Gleichnamige Kategorien (gleiche Ebene) und Stationen werden weiterverwendet; Produkte, deren Name in der Zielkategorie schon vorkommt, übersprungen (`skippedProducts`), außer mit `includeDuplicates`. Steuersatz, Pfandart, Station, Optionen, Symbol, Bild, Favorit und Druckeinstellungen kommen mit; bei steuerbefreiten Organisationen Steuersatz 0. Alles oder nichts. Scope `events:write`.',
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

  @Post(':eventId/duplicate')
  @ApiOperation({
    operationId: 'duplicateEvent',
    summary: 'Veranstaltung duplizieren',
    description:
      'Legt eine neue Veranstaltung (Status `inactive`) mit Name und Zeitraum aus dem Body an und übernimmt aus `eventId`: Kategorien, Produkte, Produktionsstationen, Einstellungen (Kassier- und Tischmodus samt Bereichen, Vorlauf, Vorverkauf, Shop; Shop-Tage um den Abstand der Beginne verschoben), Wertmarken nur dieser Veranstaltung, Schichtpläne als Entwurf (Aufgaben und Schichten verschoben, ohne Anmeldungen) und Bedienungen nur dieser Veranstaltung mit neuen PINs (`waiters[].pin`, nur in dieser Antwort). Nie Abrechnung, TSE, Bestellungen; Bestand nur mit `copyStock`. Schichtpläne nur mit Recht „Schichtpläne“, Bedienungen nur mit Recht „Bedienungen“ — sonst `skipped`. Nur in der App (kein API-Token).',
  })
  @ApiParam({
    name: 'eventId',
    description: 'ID der Veranstaltung, die dupliziert wird',
    format: 'uuid',
  })
  async duplicate(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() dto: DuplicateEventDto,
    @CurrentUser() user: User,
  ) {
    const result = await this.eventsService.duplicate(
      organizationId,
      eventId,
      dto,
      user,
    );
    return {
      data: {
        ...result,
        event: await this.eventPhase.decorate(result.event),
      },
    };
  }
}
