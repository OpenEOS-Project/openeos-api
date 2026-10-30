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
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser, ApiTokenAccess } from '../../common/decorators';
import { TokenScope } from '../api-tokens/api-scopes';
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
@ApiParam({
  name: 'organizationId',
  description: 'ID der Organisation',
  format: 'uuid',
})
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId')
export class TablesController {
  constructor(private readonly tablesService: TablesService) {}

  // Bereiche

  @ApiTokenAccess(TokenScope.READ)
  @Get('table-areas')
  @ApiOperation({
    operationId: 'listTableAreas',
    summary: 'Bereiche und Tische auflisten',
    description:
      'Alle Bereiche der Organisation inklusive ihrer Tische (aktive und inaktive) und des Tischplans. Scope `read`.',
  })
  async listAreas(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() user: User,
  ) {
    return { data: await this.tablesService.listAreas(organizationId, user) };
  }

  @ApiTokenAccess(TokenScope.TABLES_WRITE)
  @Post('table-areas')
  @ApiOperation({
    operationId: 'createTableArea',
    summary: 'Bereich anlegen',
    description:
      'Legt einen Bereich (z. B. Festzelt, Biergarten) an. Scope `tables:write` und Modulrecht Veranstaltungen.',
  })
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
  @ApiTokenAccess(TokenScope.TABLES_WRITE)
  @Patch('table-areas/order')
  @ApiOperation({
    operationId: 'reorderTableAreas',
    summary: 'Bereiche sortieren',
    description:
      'Setzt die Reihenfolge der Bereiche anhand der übergebenen ID-Liste. Scope `tables:write`.',
  })
  async reorderAreas(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: ReorderTableAreasDto,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.tablesService.reorderAreas(organizationId, dto, user),
    };
  }

  @ApiTokenAccess(TokenScope.TABLES_WRITE)
  @Patch('table-areas/:areaId')
  @ApiOperation({
    operationId: 'updateTableArea',
    summary: 'Bereich ändern',
    description:
      'Ändert Name, Größe, Raster oder Deko eines Bereichs. Scope `tables:write`.',
  })
  @ApiParam({ name: 'areaId', description: 'ID des Bereichs', format: 'uuid' })
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

  @ApiTokenAccess(TokenScope.TABLES_WRITE)
  @Put('table-areas/:areaId/layout')
  @ApiOperation({
    operationId: 'putTableAreaLayout',
    summary: 'Tischplan eines Bereichs speichern',
    description:
      'Ersetzt die Karte eines Bereichs (Positionen der Tische und Deko) vollständig. Scope `tables:write`.',
  })
  @ApiParam({ name: 'areaId', description: 'ID des Bereichs', format: 'uuid' })
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

  @ApiTokenAccess(TokenScope.TABLES_WRITE)
  @Post('tables')
  @ApiOperation({
    operationId: 'createTable',
    summary: 'Tisch anlegen',
    description: 'Legt einen Tisch in einem Bereich an. Scope `tables:write`.',
  })
  async createTable(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: CreateDiningTableDto,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.tablesService.createTable(organizationId, dto, user),
    };
  }

  @ApiTokenAccess(TokenScope.TABLES_WRITE)
  @Post('tables/bulk')
  @ApiOperation({
    operationId: 'createTablesBulk',
    summary: 'Tischserie anlegen',
    description:
      'Legt mehrere Tische mit fortlaufender Nummer in einem Aufruf an (z. B. A01–A12). Scope `tables:write`.',
  })
  async bulkCreate(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: BulkCreateDiningTablesDto,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.tablesService.bulkCreate(organizationId, dto, user),
    };
  }

  @ApiTokenAccess(TokenScope.TABLES_WRITE)
  @Patch('tables/:tableId')
  @ApiOperation({
    operationId: 'updateTable',
    summary: 'Tisch ändern',
    description:
      'Ändert Name, Plätze, Position oder Bereich eines Tischs. Scope `tables:write`.',
  })
  @ApiParam({ name: 'tableId', description: 'ID des Tischs', format: 'uuid' })
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
