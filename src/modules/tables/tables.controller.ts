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
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';
import { TablesService } from './tables.service';
import {
  BulkCreateDiningTablesDto,
  CreateDiningTableDto,
  CreateTableAreaDto,
  PutTableAreaLayoutDto,
  ReorderTableAreasDto,
  UpdateDiningTableDto,
  UpdateTableAreaDto,
} from './dto';

/**
 * Bereiche und Tische der Organisation. Lesen: Mitglieder; Schreiben:
 * Admins oder Mitglieder mit Veranstaltungsrecht (`permissions.events`).
 * Jede Aenderung sendet `tablesUpdated` an den Organisationsraum.
 */
@ApiTags('Tables')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId')
export class TablesController {
  constructor(private readonly tablesService: TablesService) {}

  // Bereiche

  @Get('table-areas')
  @ApiOperation({ summary: 'Bereiche inkl. Tische (aktiv und inaktiv)' })
  async listAreas(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() user: User,
  ) {
    return { data: await this.tablesService.listAreas(organizationId, user) };
  }

  @Post('table-areas')
  @ApiOperation({ summary: 'Bereich anlegen' })
  async createArea(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: CreateTableAreaDto,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.tablesService.createArea(organizationId, dto, user),
    };
  }

  // Vor `:areaId`, sonst greift die UUID-Pruefung auf „order“.
  @Patch('table-areas/order')
  @ApiOperation({ summary: 'Bereiche sortieren' })
  async reorderAreas(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: ReorderTableAreasDto,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.tablesService.reorderAreas(organizationId, dto, user),
    };
  }

  @Patch('table-areas/:areaId')
  @ApiOperation({ summary: 'Bereich ändern (Name, Größe, Raster, Deko)' })
  async updateArea(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('areaId', ParseUUIDPipe) areaId: string,
    @Body() dto: UpdateTableAreaDto,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.tablesService.updateArea(
        organizationId,
        areaId,
        dto,
        user,
      ),
    };
  }

  @Put('table-areas/:areaId/layout')
  @ApiOperation({ summary: 'Karte eines Bereichs speichern (Autosave)' })
  async putLayout(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('areaId', ParseUUIDPipe) areaId: string,
    @Body() dto: PutTableAreaLayoutDto,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.tablesService.putLayout(
        organizationId,
        areaId,
        dto,
        user,
      ),
    };
  }

  @Delete('table-areas/:areaId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Bereich samt Tischen löschen' })
  async removeArea(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('areaId', ParseUUIDPipe) areaId: string,
    @CurrentUser() user: User,
  ) {
    await this.tablesService.removeArea(organizationId, areaId, user);
  }

  // Tische

  @Post('tables')
  @ApiOperation({ summary: 'Tisch anlegen' })
  async createTable(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: CreateDiningTableDto,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.tablesService.createTable(organizationId, dto, user),
    };
  }

  @Post('tables/bulk')
  @ApiOperation({ summary: 'Serie anlegen (z. B. A01–A12)' })
  async bulkCreate(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: BulkCreateDiningTablesDto,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.tablesService.bulkCreate(organizationId, dto, user),
    };
  }

  @Patch('tables/:tableId')
  @ApiOperation({ summary: 'Tisch ändern, umbenennen oder verschieben' })
  async updateTable(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('tableId', ParseUUIDPipe) tableId: string,
    @Body() dto: UpdateDiningTableDto,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.tablesService.updateTable(
        organizationId,
        tableId,
        dto,
        user,
      ),
    };
  }

  @Delete('tables/:tableId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Tisch löschen' })
  async removeTable(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('tableId', ParseUUIDPipe) tableId: string,
    @CurrentUser() user: User,
  ) {
    await this.tablesService.removeTable(organizationId, tableId, user);
  }
}
