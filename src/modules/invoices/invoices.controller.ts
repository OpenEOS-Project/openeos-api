import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { InvoicesService } from './invoices.service';
import { QueryInvoicesDto } from './dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentOrganization } from '../../common/decorators/current-organization.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { OrganizationGuard } from '../../common/guards/organization.guard';
import { Role } from '../../common/constants/roles.enum';
import type { Organization } from '../../database/entities';

@ApiTags('Invoices')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/invoices')
@UseGuards(OrganizationGuard, RolesGuard)
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Get()
  @Roles(Role.ADMIN)
  async findAll(
    @CurrentOrganization() organization: Organization,
    @Query() queryDto: QueryInvoicesDto,
  ) {
    const result = await this.invoicesService.findAll(organization.id, queryDto);
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

  @Get(':id')
  @Roles(Role.ADMIN)
  async findOne(
    @CurrentOrganization() organization: Organization,
    @Param('id') id: string,
  ) {
    const invoice = await this.invoicesService.findOne(organization.id, id);
    return {
      data: invoice,
    };
  }

  @Get(':id/pdf')
  @Roles(Role.ADMIN)
  async getPdfUrl(
    @CurrentOrganization() organization: Organization,
    @Param('id') id: string,
  ) {
    const pdfUrl = await this.invoicesService.generatePdfUrl(organization.id, id);
    return {
      data: { pdfUrl },
    };
  }
}
