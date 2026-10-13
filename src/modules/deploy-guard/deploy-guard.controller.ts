import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../../common/decorators';
import { DeployGuardTokenGuard } from './deploy-guard-token.guard';
import { DeployGuardService } from './deploy-guard.service';
import { DeployGuardQueryDto } from './dto/deploy-guard-query.dto';

/**
 * Asked by the production deploy workflows before they roll out a new
 * version: while a festival is selling, the deploy waits.
 *
 * Not a user endpoint — no JWT, but a shared secret (`DEPLOY_GUARD_TOKEN`,
 * also stored as a GitHub Actions secret). Without that variable the route
 * answers 404.
 */
@ApiTags('Internal')
@ApiBearerAuth()
@Public()
@UseGuards(DeployGuardTokenGuard)
@Controller('internal/deploy-guard')
export class DeployGuardController {
  constructor(private readonly deployGuard: DeployGuardService) {}

  @Get()
  @ApiOperation({
    summary: 'Is an event selling right now?',
    description:
      'busy = an active event took a non-test order within the window ' +
      '(default 30 min). Lists those events with their last order time.',
  })
  status(@Query() query: DeployGuardQueryDto) {
    return this.deployGuard.status(query.windowMinutes);
  }
}
