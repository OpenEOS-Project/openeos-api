import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import type { Request } from 'express';
import { AdminService } from './admin.service';
import {
  QueryOrganizationsDto,
  QueryUsersDto,
  QueryPurchasesDto,
  QueryInvoicesAdminDto,
  QueryAuditLogsDto,
  QueryRentalHardwareDto,
  QueryRentalAssignmentsAdminDto,
  QueryCreditPackagesDto,
  AdjustCreditsDto,
  SetDiscountDto,
  AccessOrganizationDto,
  CreateRentalHardwareDto,
  UpdateRentalHardwareDto,
  CreateRentalAssignmentDto,
  UpdateRentalAssignmentDto,
  UpdateOrganizationAdminDto,
  CreateSubscriptionConfigDto,
  UpdateSubscriptionConfigDto,
  CreateCreditPackageDto,
  UpdateCreditPackageDto,
} from './dto';
import { SuperAdminGuard } from '../../common/guards/super-admin.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { User } from '../../database/entities';

@ApiTags('Admin')
@ApiBearerAuth('JWT-auth')
@Controller('admin')
@UseGuards(SuperAdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  private getClientInfo(req: Request): { ip: string; userAgent?: string } {
    const ip = (req as { ip?: string }).ip || req.socket?.remoteAddress || '0.0.0.0';
    const userAgent = req.headers['user-agent'];
    return { ip, userAgent };
  }

  // === Organizations ===

  @Get('organizations')
  async findAllOrganizations(@Query() queryDto: QueryOrganizationsDto) {
    const result = await this.adminService.findAllOrganizations(queryDto);
    return {
      data: result.data,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        pages: Math.ceil(result.total / result.limit),
      },
    };
  }

  @Get('organizations/:id')
  async getOrganization(@Param('id') id: string) {
    const org = await this.adminService.getOrganization(id);
    return { data: org };
  }

  @Patch('organizations/:id')
  async updateOrganization(
    @Param('id') id: string,
    @Body() updateDto: UpdateOrganizationAdminDto,
    @CurrentUser() user: User,
    @Req() req: unknown,
  ) {
    const { ip, userAgent } = this.getClientInfo(req as Request);
    const org = await this.adminService.updateOrganization(id, updateDto, user.id, ip, userAgent);
    return { data: org };
  }

  @Patch('organizations/:id/credits')
  async adjustCredits(
    @Param('id') id: string,
    @Body() adjustDto: AdjustCreditsDto,
    @CurrentUser() user: User,
    @Req() req: unknown,
  ) {
    const { ip, userAgent } = this.getClientInfo(req as Request);
    const org = await this.adminService.adjustCredits(id, adjustDto, user.id, ip, userAgent);
    return { data: org };
  }

  @Patch('organizations/:id/discount')
  async setDiscount(
    @Param('id') id: string,
    @Body() discountDto: SetDiscountDto,
    @CurrentUser() user: User,
    @Req() req: unknown,
  ) {
    const { ip, userAgent } = this.getClientInfo(req as Request);
    const org = await this.adminService.setDiscount(id, discountDto, user.id, ip, userAgent);
    return { data: org };
  }

  @Delete('organizations/:id/discount')
  async removeDiscount(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Req() req: unknown,
  ) {
    const { ip, userAgent } = this.getClientInfo(req as Request);
    const org = await this.adminService.removeDiscount(id, user.id, ip, userAgent);
    return { data: org };
  }

  @Post('organizations/:id/access')
  async accessWithPin(
    @Param('id') id: string,
    @Body() accessDto: AccessOrganizationDto,
    @CurrentUser() user: User,
    @Req() req: unknown,
  ) {
    const { ip, userAgent } = this.getClientInfo(req as Request);
    await this.adminService.accessOrganizationWithPin(id, accessDto, user.id, ip, userAgent);
    return { data: { success: true } };
  }

  @Get('organizations/:id/impersonate')
  async impersonate(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Req() req: unknown,
  ) {
    const { ip, userAgent } = this.getClientInfo(req as Request);
    const token = await this.adminService.impersonateOrganization(id, user.id, ip, userAgent);
    return { data: { impersonateToken: token } };
  }

  // === Users ===

  @Get('users')
  async findAllUsers(@Query() queryDto: QueryUsersDto) {
    const result = await this.adminService.findAllUsers(queryDto);
    return {
      data: result.data,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        pages: Math.ceil(result.total / result.limit),
      },
    };
  }

  @Post('users/:id/unlock')
  async unlockUser(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Req() req: unknown,
  ) {
    const { ip, userAgent } = this.getClientInfo(req as Request);
    const unlocked = await this.adminService.unlockUser(id, user.id, ip, userAgent);
    return { data: unlocked };
  }

  // === Purchases ===

  @Get('purchases')
  async findAllPurchases(@Query() queryDto: QueryPurchasesDto) {
    const result = await this.adminService.findAllPurchases(queryDto);
    return {
      data: result.data,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        pages: Math.ceil(result.total / result.limit),
      },
    };
  }

  @Post('purchases/:id/complete')
  async completePurchase(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Req() req: unknown,
  ) {
    const { ip, userAgent } = this.getClientInfo(req as Request);
    const purchase = await this.adminService.completePurchase(id, user.id, ip, userAgent);
    return { data: purchase };
  }

  // === Invoices ===

  @Get('invoices')
  async findAllInvoices(@Query() queryDto: QueryInvoicesAdminDto) {
    const result = await this.adminService.findAllInvoices(queryDto);
    return {
      data: result.data,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        pages: Math.ceil(result.total / result.limit),
      },
    };
  }

  @Post('invoices/:id/mark-paid')
  async markInvoicePaid(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Req() req: unknown,
  ) {
    const { ip, userAgent } = this.getClientInfo(req as Request);
    const invoice = await this.adminService.markInvoicePaid(id, user.id, ip, userAgent);
    return { data: invoice };
  }

  // === Rental Hardware ===

  @Get('rental-hardware')
  async findAllRentalHardware(@Query() queryDto: QueryRentalHardwareDto) {
    const result = await this.adminService.findAllRentalHardware(queryDto);
    return {
      data: result.data,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        pages: Math.ceil(result.total / result.limit),
      },
    };
  }

  @Post('rental-hardware')
  async createRentalHardware(
    @Body() createDto: CreateRentalHardwareDto,
    @CurrentUser() user: User,
    @Req() req: unknown,
  ) {
    const { ip, userAgent } = this.getClientInfo(req as Request);
    const hardware = await this.adminService.createRentalHardware(createDto, user.id, ip, userAgent);
    return { data: hardware };
  }

  @Patch('rental-hardware/:id')
  async updateRentalHardware(
    @Param('id') id: string,
    @Body() updateDto: UpdateRentalHardwareDto,
  ) {
    const hardware = await this.adminService.updateRentalHardware(id, updateDto);
    return { data: hardware };
  }

  @Delete('rental-hardware/:id')
  async deleteRentalHardware(@Param('id') id: string) {
    await this.adminService.deleteRentalHardware(id);
    return { data: { success: true } };
  }

  // === Rental Assignments ===

  @Get('rental-assignments')
  async findAllRentalAssignments(@Query() queryDto: QueryRentalAssignmentsAdminDto) {
    const result = await this.adminService.findAllRentalAssignments(queryDto);
    return {
      data: result.data,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        pages: Math.ceil(result.total / result.limit),
      },
    };
  }

  @Post('rental-assignments')
  async createRentalAssignment(
    @Body() createDto: CreateRentalAssignmentDto,
    @CurrentUser() user: User,
    @Req() req: unknown,
  ) {
    const { ip, userAgent } = this.getClientInfo(req as Request);
    const assignment = await this.adminService.createRentalAssignment(createDto, user.id, ip, userAgent);
    return { data: assignment };
  }

  @Post('rental-assignments/:id/return')
  async returnRental(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Req() req: unknown,
  ) {
    const { ip, userAgent } = this.getClientInfo(req as Request);
    const assignment = await this.adminService.returnRental(id, user.id, ip, userAgent);
    return { data: assignment };
  }

  // === Statistics ===

  @Get('stats/overview')
  async getOverviewStats() {
    const stats = await this.adminService.getOverviewStats();
    return { data: stats };
  }

  @Get('stats/revenue')
  async getRevenueStats(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const stats = await this.adminService.getRevenueStats(startDate, endDate);
    return { data: stats };
  }

  // === Audit Logs ===

  @Get('audit-logs')
  async findAuditLogs(@Query() queryDto: QueryAuditLogsDto) {
    const result = await this.adminService.findAuditLogs(queryDto);
    return {
      data: result.data,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        pages: Math.ceil(result.total / result.limit),
      },
    };
  }

  // === Subscription Config ===

  @Get('subscription-config')
  async getSubscriptionConfig() {
    const config = await this.adminService.getSubscriptionConfig();
    return { data: config };
  }

  @Get('subscription-configs')
  async getAllSubscriptionConfigs() {
    const configs = await this.adminService.getAllSubscriptionConfigs();
    return { data: configs };
  }

  @Post('subscription-config')
  async createSubscriptionConfig(@Body() createDto: CreateSubscriptionConfigDto) {
    const config = await this.adminService.createSubscriptionConfig(createDto);
    return { data: config };
  }

  @Patch('subscription-config/:id')
  async updateSubscriptionConfig(
    @Param('id') id: string,
    @Body() updateDto: UpdateSubscriptionConfigDto,
  ) {
    const config = await this.adminService.updateSubscriptionConfig(id, updateDto);
    return { data: config };
  }

  @Delete('subscription-config/:id')
  async deleteSubscriptionConfig(@Param('id') id: string) {
    await this.adminService.deleteSubscriptionConfig(id);
    return { data: { success: true } };
  }

  // === Credit Packages ===

  @Get('credit-packages')
  async findAllCreditPackages(@Query() queryDto: QueryCreditPackagesDto) {
    const result = await this.adminService.findAllCreditPackages(queryDto);
    return {
      data: result.data,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        pages: Math.ceil(result.total / result.limit),
      },
    };
  }

  @Get('credit-packages/:id')
  async getCreditPackage(@Param('id') id: string) {
    const pkg = await this.adminService.getCreditPackage(id);
    return { data: pkg };
  }

  @Post('credit-packages')
  async createCreditPackage(@Body() createDto: CreateCreditPackageDto) {
    const pkg = await this.adminService.createCreditPackage(createDto);
    return { data: pkg };
  }

  @Patch('credit-packages/:id')
  async updateCreditPackage(
    @Param('id') id: string,
    @Body() updateDto: UpdateCreditPackageDto,
  ) {
    const pkg = await this.adminService.updateCreditPackage(id, updateDto);
    return { data: pkg };
  }

  @Delete('credit-packages/:id')
  async deleteCreditPackage(@Param('id') id: string) {
    await this.adminService.deleteCreditPackage(id);
    return { data: { success: true } };
  }
}
