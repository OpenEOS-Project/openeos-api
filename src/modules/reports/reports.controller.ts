import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import type { Response } from 'express';
import { ReportsService } from './reports.service';
import { QueryReportsDto, ExportReportsDto, ReportExportFormat } from './dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentOrganization } from '../../common/decorators/current-organization.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { OrganizationGuard } from '../../common/guards/organization.guard';
import { Role } from '../../common/constants/roles.enum';
import type { User } from '../../database/entities';

@ApiTags('Reports')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/reports')
@UseGuards(OrganizationGuard, RolesGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('sales')
  @Roles(Role.MEMBER)
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

  @Get('products')
  @Roles(Role.MEMBER)
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

  @Get('payments')
  @Roles(Role.MEMBER)
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

  @Get('hourly')
  @Roles(Role.MEMBER)
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

  @Get('inventory')
  @Roles(Role.MEMBER)
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

  @Get('stock-movements')
  @Roles(Role.MEMBER)
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

  @Get('export')
  @Roles(Role.MEMBER)
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
}
