import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import type { Response } from 'express';
import { ReportsService } from './reports.service';
import { QueryReportsDto, ExportReportsDto, ReportExportFormat } from './dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentOrganization } from '../../common/decorators/current-organization.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { OrganizationGuard } from '../../common/guards/organization.guard';
import { Role } from '../../common/constants/roles.enum';

@ApiTags('Reports')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/reports')
@UseGuards(OrganizationGuard, RolesGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('sales')
  @Roles(Role.ADMIN)
  async getSalesReport(
    @CurrentOrganization() organizationId: string,
    @Query() queryDto: QueryReportsDto,
  ) {
    const report = await this.reportsService.getSalesReport(
      organizationId,
      queryDto,
    );
    return { data: report };
  }

  @Get('products')
  @Roles(Role.ADMIN)
  async getProductsReport(
    @CurrentOrganization() organizationId: string,
    @Query() queryDto: QueryReportsDto,
  ) {
    const report = await this.reportsService.getProductsReport(
      organizationId,
      queryDto,
    );
    return { data: report };
  }

  @Get('payments')
  @Roles(Role.ADMIN)
  async getPaymentsReport(
    @CurrentOrganization() organizationId: string,
    @Query() queryDto: QueryReportsDto,
  ) {
    const report = await this.reportsService.getPaymentsReport(
      organizationId,
      queryDto,
    );
    return { data: report };
  }

  @Get('hourly')
  @Roles(Role.ADMIN)
  async getHourlyReport(
    @CurrentOrganization() organizationId: string,
    @Query() queryDto: QueryReportsDto,
  ) {
    const report = await this.reportsService.getHourlyReport(
      organizationId,
      queryDto,
    );
    return { data: report };
  }

  @Get('inventory')
  @Roles(Role.ADMIN)
  async getInventoryReport(@CurrentOrganization() organizationId: string) {
    const report = await this.reportsService.getInventoryReport(organizationId);
    return { data: report };
  }

  @Get('stock-movements')
  @Roles(Role.ADMIN)
  async getStockMovementsReport(
    @CurrentOrganization() organizationId: string,
    @Query() queryDto: QueryReportsDto,
  ) {
    const report = await this.reportsService.getStockMovementsReport(
      organizationId,
      queryDto,
    );
    return { data: report };
  }

  @Get('export')
  @Roles(Role.ADMIN)
  async exportReport(
    @CurrentOrganization() organizationId: string,
    @Query() exportDto: ExportReportsDto,
    @Query('type') reportType: string,
    @Res() res: unknown,
  ) {
    const result = await this.reportsService.exportReport(
      organizationId,
      reportType || 'sales',
      exportDto,
      exportDto.format || ReportExportFormat.JSON,
    );

    const response = res as Response;
    response.setHeader('Content-Type', result.contentType);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.filename}"`,
    );
    response.send(result.data);
  }
}
