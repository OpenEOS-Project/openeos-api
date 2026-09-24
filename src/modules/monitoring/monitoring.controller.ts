import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { MonitoringService } from './monitoring.service';
import { RequiresScope } from '../../common/decorators';
import { API_SCOPES } from '../api-tokens/api-scopes';
import { SuperAdminGuard } from '../../common/guards/super-admin.guard';

/**
 * Kennzahlen für die Überwachung.
 *
 * Erreichbar mit einem API-Token, der `monitoring:read` trägt — oder
 * angemeldet als Super-Admin, damit sich dieselben Zahlen im Browser
 * ansehen lassen, ohne dafür einen Token auszustellen.
 */
@ApiTags('Monitoring')
@ApiBearerAuth('JWT-auth')
@Controller('monitoring')
@UseGuards(SuperAdminGuard)
export class MonitoringController {
  constructor(private readonly monitoringService: MonitoringService) {}

  @Get('metrics')
  @RequiresScope(API_SCOPES.MONITORING_READ)
  @ApiOperation({
    summary: 'Platform counters for monitoring',
    description:
      'Aggregates only — no names, no addresses. Shaped to stay stable, ' +
      'unlike the admin lists, which follow the UI.',
  })
  async metrics() {
    const data = await this.monitoringService.kennzahlen();
    return { data };
  }
}
