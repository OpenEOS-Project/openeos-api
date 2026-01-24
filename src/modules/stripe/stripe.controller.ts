import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StripeService } from './stripe.service';
import { CreateCheckoutDto, CreatePortalSessionDto } from './dto';
import { CurrentUser, CurrentOrganization, Roles } from '../../common/decorators';
import { OrganizationGuard, RolesGuard } from '../../common/guards';
import { Role } from '../../common/constants/roles.enum';
import { User, Organization } from '../../database/entities';

@ApiTags('Billing')
@Controller('organizations/:organizationId/billing')
@UseGuards(OrganizationGuard, RolesGuard)
export class StripeController {
  constructor(
    private readonly stripeService: StripeService,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
  ) {}

  @Get()
  @Roles(Role.ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get billing overview', description: 'Get billing information for organization' })
  @ApiParam({ name: 'organizationId', description: 'Organization ID' })
  @ApiResponse({ status: 200, description: 'Billing overview' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async getBillingOverview(@CurrentOrganization() organization: Organization) {
    const overview = await this.stripeService.getBillingOverview(organization);
    return { data: overview };
  }

  @Post('checkout/credits')
  @Roles(Role.ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Create credit checkout', description: 'Create Stripe checkout session for credits' })
  @ApiParam({ name: 'organizationId', description: 'Organization ID' })
  @ApiResponse({ status: 201, description: 'Checkout URL' })
  @ApiResponse({ status: 400, description: 'Invalid package' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async createCreditCheckout(
    @CurrentUser() user: User,
    @CurrentOrganization() organization: Organization,
    @Body() dto: CreateCheckoutDto,
  ) {
    const url = await this.stripeService.createCreditCheckoutSession(
      organization,
      dto.packageId,
      user.id,
      dto.successUrl,
      dto.cancelUrl,
    );
    return { data: { url } };
  }

  @Post('checkout/subscription')
  @Roles(Role.ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Create subscription checkout', description: 'Create Stripe checkout session for subscription' })
  @ApiParam({ name: 'organizationId', description: 'Organization ID' })
  @ApiResponse({ status: 201, description: 'Checkout URL' })
  @ApiResponse({ status: 400, description: 'Already subscribed' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async createSubscriptionCheckout(
    @CurrentOrganization() organization: Organization,
    @Body() dto: CreatePortalSessionDto,
  ) {
    const url = await this.stripeService.createSubscriptionCheckoutSession(
      organization,
      dto.returnUrl,
      dto.returnUrl, // cancel goes to same URL
    );
    return { data: { url } };
  }

  @Post('portal')
  @Roles(Role.ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Create billing portal session', description: 'Create Stripe billing portal session' })
  @ApiParam({ name: 'organizationId', description: 'Organization ID' })
  @ApiResponse({ status: 201, description: 'Portal URL' })
  @ApiResponse({ status: 400, description: 'No payment info' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async createPortalSession(
    @CurrentOrganization() organization: Organization,
    @Body() dto: CreatePortalSessionDto,
  ) {
    const url = await this.stripeService.createPortalSession(organization, dto.returnUrl);
    return { data: { url } };
  }

  @Get('history')
  @Roles(Role.ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get payment history', description: 'Get payment history for organization' })
  @ApiParam({ name: 'organizationId', description: 'Organization ID' })
  @ApiResponse({ status: 200, description: 'Payment history' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async getPaymentHistory(@CurrentOrganization() organization: Organization) {
    const history = await this.stripeService.getPaymentHistory(organization.id);
    return { data: history };
  }
}
