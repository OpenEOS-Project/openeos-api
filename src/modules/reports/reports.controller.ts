import {
  Controller,
  Get,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import type { Response } from 'express';
import { ReportsService } from './reports.service';
import { QueryReportsDto, ExportReportsDto, ReportExportFormat } from './dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentOrganization } from '../../common/decorators/current-organization.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { OrganizationGuard } from '../../common/guards/organization.guard';
import { Role } from '../../common/constants/roles.enum';
import type { Organization } from '../../database/entities';

@ApiTags('Reports')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/reports')
@UseGuards(OrganizationGuard, RolesGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('sales')
  @Roles(Role.ADMIN, Role.MANAGER)
  async getSalesReport(
    @CurrentOrganization() organization: Organization,
    @Query() queryDto: QueryReportsDto,
  ) {
    const report = await this.reportsService.getSalesReport(organization.id, queryDto);
    return { data: report };
  }

  @Get('products')
  @Roles(Role.ADMIN, Role.MANAGER)
  async getProductsReport(
    @CurrentOrganization() organization: Organization,
    @Query() queryDto: QueryReportsDto,
  ) {
    const report = await this.reportsService.getProductsReport(organization.id, queryDto);
    return { data: report };
  }

  @Get('payments')
  @Roles(Role.ADMIN, Role.MANAGER)
  async getPaymentsReport(
    @CurrentOrganization() organization: Organization,
    @Query() queryDto: QueryReportsDto,
  ) {
    const report = await this.reportsService.getPaymentsReport(organization.id, queryDto);
    return { data: report };
  }

  @Get('hourly')
  @Roles(Role.ADMIN, Role.MANAGER)
  async getHourlyReport(
    @CurrentOrganization() organization: Organization,
    @Query() queryDto: QueryReportsDto,
  ) {
    const report = await this.reportsService.getHourlyReport(organization.id, queryDto);
    return { data: report };
  }

  @Get('inventory')
  @Roles(Role.ADMIN, Role.MANAGER)
  async getInventoryReport(@CurrentOrganization() organization: Organization) {
    const report = await this.reportsService.getInventoryReport(organization.id);
    return { data: report };
  }

  @Get('stock-movements')
  @Roles(Role.ADMIN, Role.MANAGER)
  async getStockMovementsReport(
    @CurrentOrganization() organization: Organization,
    @Query() queryDto: QueryReportsDto,
  ) {
    const report = await this.reportsService.getStockMovementsReport(organization.id, queryDto);
    return { data: report };
  }

  @Get('export')
  @Roles(Role.ADMIN, Role.MANAGER)
  async exportReport(
    @CurrentOrganization() organization: Organization,
    @Query() exportDto: ExportReportsDto,
    @Query('type') reportType: string,
    @Res() res: unknown,
  ) {
    const result = await this.reportsService.exportReport(
      organization.id,
      reportType || 'sales',
      exportDto,
      exportDto.format || ReportExportFormat.JSON,
    );

    const response = res as Response;
    response.setHeader('Content-Type', result.contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    response.send(result.data);
  }
}
