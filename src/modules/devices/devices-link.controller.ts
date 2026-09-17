import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { DevicesService } from './devices.service';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';
import { LinkDeviceDto } from './dto';

@ApiTags('Devices')
@ApiBearerAuth('JWT-auth')
@Controller('devices')
export class DevicesLinkController {
  constructor(private readonly devicesService: DevicesService) {}

  @Post('link')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Step 3 — adopt a waiting device into an organisation',
    description: [
      'Finishes the pairing a device started with POST /devices/init. The',
      'caller must be signed in and hold the devices permission in the target',
      'organisation — the device itself never chooses where it belongs.',
      '',
      'On success the device becomes verified, its code is cleared, and its',
      'next status poll tells it where to go. Type defaults are applied here,',
      'so a display arrives already set to the customer view.',
    ].join(' '),
  })
  async linkDevice(
    @Body() linkDto: LinkDeviceDto,
    @CurrentUser() user: User,
  ) {
    const device = await this.devicesService.linkDevice(linkDto, user);
    return {
      data: {
        deviceId: device.id,
        name: device.name,
        type: device.type,
        organizationId: device.organizationId,
        status: device.status,
      },
    };
  }
}
