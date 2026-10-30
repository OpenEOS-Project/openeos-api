import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ApiTokenAccess } from '../../common/decorators';
import { TokenScope } from '../api-tokens/api-scopes';
import type { Response } from 'express';
import { ReportsService } from './reports.service';
import { GatewayService } from '../gateway/gateway.service';
import { QueryReportsDto, ExportReportsDto, ReportExportFormat } from './dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentOrganization } from '../../common/decorators/current-organization.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { OrganizationGuard } from '../../common/guards/organization.guard';
import { Role } from '../../common/constants/roles.enum';
import type { User } from '../../database/entities';

@ApiTags('Reports')
@ApiParam({
  name: 'organizationId',
  description: 'ID der Organisation',
  format: 'uuid',
})
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/reports')
@UseGuards(OrganizationGuard, RolesGuard)
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly gatewayService: GatewayService,
  ) {}

  @ApiTokenAccess(TokenScope.READ)
  @Get('sales')
  @Roles(Role.MEMBER)
  @ApiOperation({
    operationId: 'getSalesReport',
    summary: 'Umsatzbericht',
    description:
      'Umsatz, Bestellungen und Durchschnittsbon im Zeitraum (`startDate`, `endDate`), optional je Veranstaltung und gruppiert (`groupBy`). Scope `read` und Modulrecht Auswertung.',
  })
  async getSalesReport(
    @CurrentOrganization() organizationId: string,
    @Query() queryDto: QueryReportsDto,
    @CurrentUser() user: User,
  ) {
    const report = await this.reportsService.getSalesReport(
      organizationId,
      queryDto,
      user,
    );
    return { data: report };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get('products')
  @Roles(Role.MEMBER)
  @ApiOperation({
    operationId: 'getProductsReport',
    summary: 'Umsatzbericht je Produkt',
    description:
      'Verkaufte Menge und Umsatz je Produkt im Zeitraum, optional je Veranstaltung. Scope `read` und Modulrecht Auswertung.',
  })
  async getProductsReport(
    @CurrentOrganization() organizationId: string,
    @Query() queryDto: QueryReportsDto,
    @CurrentUser() user: User,
  ) {
    const report = await this.reportsService.getProductsReport(
      organizationId,
      queryDto,
      user,
    );
    return { data: report };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get('payments')
  @Roles(Role.MEMBER)
  @ApiOperation({
    operationId: 'getPaymentsReport',
    summary: 'Zahlungsbericht je Zahlart',
    description:
      'Summen und Anzahl je Zahlart (bar, Karte, SumUp, Rabatt) im Zeitraum. Scope `read` und Modulrecht Auswertung.',
  })
  async getPaymentsReport(
    @CurrentOrganization() organizationId: string,
    @Query() queryDto: QueryReportsDto,
    @CurrentUser() user: User,
  ) {
    const report = await this.reportsService.getPaymentsReport(
      organizationId,
      queryDto,
      user,
    );
    return { data: report };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get('hourly')
  @Roles(Role.MEMBER)
  @ApiOperation({
    operationId: 'getHourlyReport',
    summary: 'Umsatz je Stunde',
    description:
      'Bestellungen und Umsatz je Stunde im Zeitraum, für Stoßzeiten und Personalplanung. Scope `read` und Modulrecht Auswertung.',
  })
  async getHourlyReport(
    @CurrentOrganization() organizationId: string,
    @Query() queryDto: QueryReportsDto,
    @CurrentUser() user: User,
  ) {
    const report = await this.reportsService.getHourlyReport(
      organizationId,
      queryDto,
      user,
    );
    return { data: report };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get('channels')
  @Roles(Role.MEMBER)
  @ApiOperation({
    operationId: 'getChannelsReport',
    summary: 'Umsatz je Bestellkanal',
    description:
      'Bestellungen und Umsatz je Kanal (Kasse, Online, QR-Bestellung) im Zeitraum. Scope `read` und Modulrecht Auswertung.',
  })
  async getChannelsReport(
    @CurrentOrganization() organizationId: string,
    @Query() queryDto: QueryReportsDto,
    @CurrentUser() user: User,
  ) {
    const report = await this.reportsService.getChannelsReport(
      organizationId,
      queryDto,
      user,
    );
    return { data: report };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get('categories')
  @Roles(Role.MEMBER)
  @ApiOperation({
    operationId: 'getCategoriesReport',
    summary: 'Umsatzbericht je Kategorie',
    description:
      'Verkaufte Menge, Umsatz und Anteil je Kategorie im Zeitraum. Scope `read` und Modulrecht Auswertung.',
  })
  async getCategoriesReport(
    @CurrentOrganization() organizationId: string,
    @Query() queryDto: QueryReportsDto,
    @CurrentUser() user: User,
  ) {
    const report = await this.reportsService.getCategoriesReport(
      organizationId,
      queryDto,
      user,
    );
    return { data: report };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get('net-summary')
  @Roles(Role.MEMBER)
  @ApiOperation({
    operationId: 'getNetSalesSummary',
    summary: 'Netto-Abgleich Produkte und Kategorien',
    description:
      'Produkt- und Kategoriezeilen zeigen den Warenwert netto (Storno und erstattete Mengen ab, Rabatt anteilig, ohne Pfand und Trinkgeld). Hier steht, was keiner Position gehört: `itemsRevenue` + `unassignedRefunds` (Kulanz-Erstattungen ohne Position, negativ) + `tips` = `netRevenue` (wie `totalRevenue` im Umsatzbericht). Die Summe der gerundeten Zeilen kann bei Rabatten um Cent von `itemsRevenue` abweichen. Scope `read` und Modulrecht Auswertung.',
  })
  async getNetSalesSummary(
    @CurrentOrganization() organizationId: string,
    @Query() queryDto: QueryReportsDto,
    @CurrentUser() user: User,
  ) {
    const summary = await this.reportsService.getNetSalesSummary(
      organizationId,
      queryDto,
      user,
    );
    return { data: summary };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get('devices')
  @Roles(Role.MEMBER)
  @ApiOperation({
    operationId: 'getDevicesReport',
    summary: 'Umsatz je Gerät',
    description:
      'Bestellungen und Umsatz je Kasse im Zeitraum. Scope `read` und Modulrecht Auswertung.',
  })
  async getDevicesReport(
    @CurrentOrganization() organizationId: string,
    @Query() queryDto: QueryReportsDto,
    @CurrentUser() user: User,
  ) {
    const report = await this.reportsService.getDevicesReport(
      organizationId,
      queryDto,
      user,
    );
    return { data: report };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get('inventory')
  @Roles(Role.MEMBER)
  @ApiOperation({
    operationId: 'getInventoryReport',
    summary: 'Bestandsbericht',
    description:
      'Aktueller Bestand aller Produkte mit Bestandsführung samt Warnung bei leerem Bestand. Scope `read` und Modulrecht Auswertung.',
  })
  async getInventoryReport(
    @CurrentOrganization() organizationId: string,
    @CurrentUser() user: User,
  ) {
    const report = await this.reportsService.getInventoryReport(
      organizationId,
      user,
    );
    return { data: report };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get('stock-movements')
  @Roles(Role.MEMBER)
  @ApiOperation({
    operationId: 'getStockMovementsReport',
    summary: 'Bestandsbewegungen',
    description:
      'Alle Bestandsbewegungen (Verkauf, Korrektur, Inventur) im Zeitraum, optional je Veranstaltung. Scope `read` und Modulrecht Auswertung.',
  })
  async getStockMovementsReport(
    @CurrentOrganization() organizationId: string,
    @Query() queryDto: QueryReportsDto,
    @CurrentUser() user: User,
  ) {
    const report = await this.reportsService.getStockMovementsReport(
      organizationId,
      queryDto,
      user,
    );
    return { data: report };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get('export')
  @Roles(Role.MEMBER)
  @ApiOperation({
    operationId: 'exportReport',
    summary: 'Bericht exportieren (CSV, Excel, JSON)',
    description:
      '`type` wählt den Bericht, `format` das Dateiformat; die Antwort ist ein Download (`Content-Disposition: attachment`). Scope `read` und Modulrecht Auswertung.',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    description: 'Welcher Bericht exportiert wird (Standard: sales)',
    enum: [
      'sales',
      'products',
      'payments',
      'hourly',
      'channels',
      'categories',
      'devices',
      'inventory',
    ],
  })
  async exportReport(
    @CurrentOrganization() organizationId: string,
    @Query() exportDto: ExportReportsDto,
    @Query('type') reportType: string,
    @Res() res: unknown,
    @CurrentUser() user: User,
  ) {
    const result = await this.reportsService.exportReport(
      organizationId,
      reportType || 'sales',
      exportDto,
      exportDto.format || ReportExportFormat.JSON,
      user,
    );

    const response = res as Response;
    response.setHeader('Content-Type', result.contentType);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.filename}"`,
    );
    response.send(result.data);
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get('system-status')
  @Roles(Role.MEMBER)
  @ApiOperation({
    operationId: 'getSystemStatus',
    summary: 'Systemstatus',
    description:
      'Geräte (verbunden/offline), Drucker, wartende Druckaufträge und offene Bestellungen der Organisation auf einen Blick. Scope `read` und Modulrecht Auswertung.',
  })
  async getSystemStatus(
    @CurrentOrganization() organizationId: string,
    @CurrentUser() user: User,
  ) {
    // Welche Geraete verbunden sind, weiss nur das Gateway zur Laufzeit —
    // die Datenbank kennt lediglich den letzten Kontakt.
    const onlineDeviceIds =
      await this.gatewayService.getOnlineDeviceIds(organizationId);
    const status = await this.reportsService.getSystemStatus(
      organizationId,
      user,
      onlineDeviceIds,
    );
    return { data: status };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get('activity')
  @Roles(Role.MEMBER)
  @ApiOperation({
    operationId: 'getActivityStream',
    summary: 'Letzte Aktivitäten',
    description:
      'Die jüngsten Bestellungen, Zahlungen und Druckaufträge der Organisation als Verlauf (höchstens 20 je Art). Scope `read` und Modulrecht Auswertung.',
  })
  async getActivityStream(
    @CurrentOrganization() organizationId: string,
    @CurrentUser() user: User,
  ) {
    const entries = await this.reportsService.getActivityStream(
      organizationId,
      user,
    );
    return { data: entries };
  }
}
