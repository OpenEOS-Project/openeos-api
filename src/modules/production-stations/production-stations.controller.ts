import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { ProductionStationsService } from './production-stations.service';
import { CreateProductionStationDto, UpdateProductionStationDto } from './dto';
import { CurrentUser, ApiTokenAccess } from '../../common/decorators';
import { TokenScope } from '../api-tokens/api-scopes';
import { User } from '../../database/entities';

@ApiTags('Production Stations')
@ApiParam({
  name: 'eventId',
  description: 'ID der Veranstaltung',
  format: 'uuid',
})
@ApiBearerAuth('JWT-auth')
@Controller('events/:eventId/production-stations')
export class ProductionStationsController {
  constructor(
    private readonly productionStationsService: ProductionStationsService,
  ) {}

  @ApiTokenAccess(TokenScope.EVENTS_WRITE)
  @Post()
  @ApiOperation({
    operationId: 'createProductionStation',
    summary: 'Station anlegen',
    description:
      'Legt eine Produktionsstation (Küche, Ausgabe, Bar) für die Veranstaltung an, optional mit Drucker. Scope `events:write` und Modulrecht Veranstaltungen.',
  })
  async create(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() createDto: CreateProductionStationDto,
    @CurrentUser() user: User,
  ) {
    const station = await this.productionStationsService.create(
      eventId,
      createDto,
      user,
    );
    return { data: station };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get()
  @ApiOperation({
    operationId: 'listProductionStations',
    summary: 'Stationen auflisten (je Veranstaltung)',
    description: 'Alle Produktionsstationen der Veranstaltung. Scope `read`.',
  })
  async findAll(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    const stations = await this.productionStationsService.findAll(
      eventId,
      user,
    );
    return { data: stations };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get(':stationId')
  @ApiOperation({
    operationId: 'getProductionStation',
    summary: 'Station abrufen',
    description: 'Eine Produktionsstation der Veranstaltung. Scope `read`.',
  })
  @ApiParam({
    name: 'stationId',
    description: 'ID der Station',
    format: 'uuid',
  })
  async findOne(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('stationId', ParseUUIDPipe) stationId: string,
    @CurrentUser() user: User,
  ) {
    const station = await this.productionStationsService.findOne(
      eventId,
      stationId,
      user,
    );
    return { data: station };
  }

  @ApiTokenAccess(TokenScope.EVENTS_WRITE)
  @Patch(':stationId')
  @ApiOperation({
    operationId: 'updateProductionStation',
    summary: 'Station ändern',
    description:
      'Ändert Name, Drucker oder Einstellungen einer Station. Scope `events:write`.',
  })
  @ApiParam({
    name: 'stationId',
    description: 'ID der Station',
    format: 'uuid',
  })
  async update(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('stationId', ParseUUIDPipe) stationId: string,
    @Body() updateDto: UpdateProductionStationDto,
    @CurrentUser() user: User,
  ) {
    const station = await this.productionStationsService.update(
      eventId,
      stationId,
      updateDto,
      user,
    );
    return { data: station };
  }

  @Delete(':stationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('stationId', ParseUUIDPipe) stationId: string,
    @CurrentUser() user: User,
  ) {
    await this.productionStationsService.remove(eventId, stationId, user);
  }
}
