import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { PrinterAgentsService } from './printer-agents.service';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';
import { AdoptDiscoveredPrinterDto, DiscoverPrintersDto } from './dto';

/**
 * Drucker-Agenten einer Organisation (Geraete vom Typ `printer_agent`).
 * Pairing laeuft weiter ueber `POST /devices/link`.
 */
@ApiTags('Printers')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/printer-agents')
export class PrinterAgentsController {
  constructor(private readonly printerAgentsService: PrinterAgentsService) {}

  @Get()
  @ApiOperation({ summary: 'Drucker-Agenten der Organisation' })
  list(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() user: User,
  ) {
    return this.printerAgentsService.listAgents(organizationId, user);
  }

  @Delete(':deviceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Agent samt Druckern entfernen (Zuordnungen werden gelöst)',
  })
  remove(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
    @CurrentUser() user: User,
  ) {
    return this.printerAgentsService.removeAgent(
      organizationId,
      deviceId,
      user,
    );
  }

  @Post(':deviceId/discover')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Agent neu suchen lassen (409 PRINTER_AGENT_OFFLINE, wenn nicht verbunden)',
  })
  discover(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
    @Body() dto: DiscoverPrintersDto,
    @CurrentUser() user: User,
  ) {
    return this.printerAgentsService.requestDiscovery(
      organizationId,
      deviceId,
      dto ?? {},
      user,
    );
  }

  @Get(':deviceId/discovered')
  @ApiOperation({ summary: 'Vom Agenten gefundene Drucker' })
  listDiscovered(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
    @CurrentUser() user: User,
  ) {
    return this.printerAgentsService.listDiscovered(
      organizationId,
      deviceId,
      user,
    );
  }

  @Post(':deviceId/discovered/:id/adopt')
  @ApiOperation({
    summary: 'Gefundenen Drucker übernehmen (409 PRINTER_ALREADY_ADOPTED)',
  })
  adopt(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
    @Param('id', ParseUUIDPipe) discoveredId: string,
    @Body() dto: AdoptDiscoveredPrinterDto,
    @CurrentUser() user: User,
  ) {
    return this.printerAgentsService.adopt(
      organizationId,
      deviceId,
      discoveredId,
      dto,
      user,
    );
  }
}
