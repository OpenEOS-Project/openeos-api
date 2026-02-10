import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { AdminService } from './admin.service';

@ApiTags('Pricing')
@Controller('pricing')
export class PricingPublicController {
  constructor(private readonly adminService: AdminService) {}

  @Public()
  @Get()
  async getPublicPricing() {
    // Ensure default packages exist
    const packages = await this.adminService.ensureDefaultPackages();
    const subscription = await this.adminService.getSubscriptionConfig();

    return {
      packages: packages
        .filter((p) => p.isActive)
        .map((p) => ({
          slug: p.slug,
          name: p.name,
          description: p.description,
          credits: p.credits,
          price: Number(p.price),
          savingsPercent: p.savingsPercent,
        })),
      subscription: subscription
        ? {
            name: subscription.name,
            description: subscription.description,
            priceMonthly: Number(subscription.priceMonthly),
          }
        : null,
    };
  }
}
