import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { InvoicesService } from './invoices.service';
import { QueryInvoicesDto } from './dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { OrganizationGuard } from '../../common/guards/organization.guard';
import { Role } from '../../common/constants/roles.enum';
import { SaasOnly } from '../../common/decorators/saas-only.decorator';

@ApiTags('Invoices')
@ApiBearerAuth('JWT-auth')
@SaasOnly()
@Controller('organizations/:organizationId/invoices')
@UseGuards(OrganizationGuard, RolesGuard)
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Get()
  @Roles(Role.ADMIN)
  async findAll(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() queryDto: QueryInvoicesDto,
  ) {
    const result = await this.invoicesService.findAll(organizationId, queryDto);
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
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const invoice = await this.invoicesService.findOne(organizationId, id);
    return {
      data: invoice,
    };
  }

  @Get(':id/pdf')
  @Roles(Role.ADMIN)
  async getPdfUrl(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const pdfUrl = await this.invoicesService.generatePdfUrl(
      organizationId,
      id,
    );
    return {
      data: { pdfUrl },
    };
  }
}
