import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';
import { OnboardingService } from './onboarding.service';

@ApiTags('Onboarding')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/onboarding')
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @Get('status')
  @ApiOperation({ summary: 'Fortschritt der Ersteinrichtung (Quick-Start)' })
  async getStatus(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() user: User,
  ) {
    const data = await this.onboardingService.getStatus(organizationId, user);
    return { data };
  }
}
