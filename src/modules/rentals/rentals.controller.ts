import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { RentalsService } from './rentals.service';
import { QueryRentalsDto } from './dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentOrganization } from '../../common/decorators/current-organization.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { OrganizationGuard } from '../../common/guards/organization.guard';
import { Role } from '../../common/constants/roles.enum';
import type { Organization } from '../../database/entities';

@ApiTags('Rentals')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/rentals')
@UseGuards(OrganizationGuard, RolesGuard)
export class RentalsController {
  constructor(private readonly rentalsService: RentalsService) {}

  @Get()
  @Roles(Role.ADMIN, Role.MANAGER)
  async findAll(
    @CurrentOrganization() organization: Organization,
    @Query() queryDto: QueryRentalsDto,
  ) {
    const result = await this.rentalsService.findAll(organization.id, queryDto);
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

  @Get('active')
  @Roles(Role.ADMIN, Role.MANAGER)
  async getActiveRentals(@CurrentOrganization() organization: Organization) {
    const rentals = await this.rentalsService.getActiveRentals(organization.id);
    return {
      data: rentals,
    };
  }

  @Get('upcoming')
  @Roles(Role.ADMIN, Role.MANAGER)
  async getUpcomingRentals(@CurrentOrganization() organization: Organization) {
    const rentals = await this.rentalsService.getUpcomingRentals(organization.id);
    return {
      data: rentals,
    };
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.MANAGER)
  async findOne(
    @CurrentOrganization() organization: Organization,
    @Param('id') id: string,
  ) {
    const rental = await this.rentalsService.findOne(organization.id, id);
    return {
      data: rental,
    };
  }

  @Post(':id/confirm')
  @Roles(Role.ADMIN)
  async confirmAssignment(
    @CurrentOrganization() organization: Organization,
    @Param('id') id: string,
  ) {
    const rental = await this.rentalsService.confirmAssignment(organization.id, id);
    return {
      data: rental,
    };
  }

  @Post(':id/decline')
  @Roles(Role.ADMIN)
  async declineAssignment(
    @CurrentOrganization() organization: Organization,
    @Param('id') id: string,
  ) {
    const rental = await this.rentalsService.declineAssignment(organization.id, id);
    return {
      data: rental,
    };
  }
}
