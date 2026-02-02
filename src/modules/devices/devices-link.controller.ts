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
    summary: 'Link a pending device to an organization',
    description: 'Links a device (found by verification code) to an organization. Requires admin role in the target organization.',
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
