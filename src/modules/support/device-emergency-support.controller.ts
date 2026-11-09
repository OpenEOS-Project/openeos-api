import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentDevice, Public } from '../../common/decorators';
import { DeviceAuthGuard } from '../../common/guards/device-auth.guard';
import type { Device } from '../../database/entities';
import { requireOrganization } from '../devices/device-api.controller';
import { EmergencySupportService } from './emergency-support.service';

/** Notfall-Support im Menü der Kasse (AGB 18.2). */
@ApiTags('Device API')
@ApiHeader({
  name: 'X-Device-Token',
  description: 'Device authentication token',
  required: true,
})
@Controller('device-api/support')
@Public()
@UseGuards(DeviceAuthGuard)
export class DeviceEmergencySupportController {
  constructor(private readonly emergencySupport: EmergencySupportService) {}

  @Get('emergency')
  @ApiOperation({
    summary: 'Emergency support phone for this device organization',
    description:
      'Wie `GET /organizations/{organizationId}/support/emergency` für die Organisation des Geräts: Rufnummer nur mit gebuchter, noch nicht beendeter Veranstaltung und hinterlegter Nummer, sonst `phone: null`.',
  })
  async emergency(@CurrentDevice() device: Device) {
    const organizationId = requireOrganization(device);
    return {
      data: await this.emergencySupport.forOrganization(organizationId),
    };
  }
}
