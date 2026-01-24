import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { CreditsService } from './credits.service';
import { PurchaseCreditsDto, QueryCreditHistoryDto, QueryEventLicensesDto } from './dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentOrganization } from '../../common/decorators/current-organization.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { OrganizationGuard } from '../../common/guards/organization.guard';
import { Role } from '../../common/constants/roles.enum';
import type { User, Organization } from '../../database/entities';

@ApiTags('Credits')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/credits')
@UseGuards(OrganizationGuard, RolesGuard)
export class CreditsController {
  constructor(private readonly creditsService: CreditsService) {}

  @Get()
  @Roles(Role.ADMIN, Role.MANAGER)
  async getBalance(@CurrentOrganization() organization: Organization) {
    const balance = await this.creditsService.getBalance(organization.id);
    return {
      data: balance,
    };
  }

  @Get('packages')
  @Roles(Role.ADMIN, Role.MANAGER)
  async getPackages() {
    const packages = await this.creditsService.getPackages();
    return {
      data: packages,
    };
  }

  @Get('packages/:slug')
  @Roles(Role.ADMIN, Role.MANAGER)
  async getPackage(@Param('slug') slug: string) {
    const pkg = await this.creditsService.getPackageBySlug(slug);
    return {
      data: pkg,
    };
  }

  @Post('purchase')
  @Roles(Role.ADMIN)
  async purchaseCredits(
    @CurrentOrganization() organization: Organization,
    @CurrentUser() user: User,
    @Body() purchaseDto: PurchaseCreditsDto,
  ) {
    const purchase = await this.creditsService.purchaseCredits(
      organization.id,
      user.id,
      purchaseDto,
    );
    return {
      data: purchase,
    };
  }

  @Get('history')
  @Roles(Role.ADMIN, Role.MANAGER)
  async getHistory(
    @CurrentOrganization() organization: Organization,
    @Query() queryDto: QueryCreditHistoryDto,
  ) {
    const result = await this.creditsService.getHistory(organization.id, queryDto);
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

  @Get('licenses')
  @Roles(Role.ADMIN, Role.MANAGER)
  async getLicenseUsage(
    @CurrentOrganization() organization: Organization,
    @Query() queryDto: QueryEventLicensesDto,
  ) {
    const result = await this.creditsService.getLicenseUsage(organization.id, queryDto);
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
}
