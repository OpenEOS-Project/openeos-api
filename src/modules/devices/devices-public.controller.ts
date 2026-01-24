import {
  Controller,
  Post,
  Get,
  Body,
  Headers,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader } from '@nestjs/swagger';
import { DevicesService } from './devices.service';
import { RegisterDeviceDto } from './dto';
import { Public } from '../../common/decorators/public.decorator';
import { ErrorCodes } from '../../common/constants/error-codes';

@ApiTags('Devices')
@Controller('devices')
@Public()
export class DevicesPublicController {
  constructor(private readonly devicesService: DevicesService) {}

  private getDeviceToken(headers: Record<string, string>): string {
    const token = headers['x-device-token'];
    if (!token) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Device-Token erforderlich',
      });
    }
    return token;
  }

  @Post('register')
  @ApiOperation({ summary: 'Register a new device' })
  async register(@Body() registerDto: RegisterDeviceDto) {
    const result = await this.devicesService.registerDevice(registerDto);
    return {
      data: result,
    };
  }

  @Get('status')
  @ApiOperation({ summary: 'Get device status' })
  @ApiHeader({ name: 'X-Device-Token', description: 'Device token', required: true })
  async getStatus(@Headers() headers: Record<string, string>) {
    const deviceToken = this.getDeviceToken(headers);
    const result = await this.devicesService.getDeviceStatus(deviceToken);
    return {
      data: result,
    };
  }

  @Get('me')
  @ApiOperation({ summary: 'Get current device info' })
  @ApiHeader({ name: 'X-Device-Token', description: 'Device token', required: true })
  async getMe(@Headers() headers: Record<string, string>) {
    const deviceToken = this.getDeviceToken(headers);
    const result = await this.devicesService.getDeviceInfo(deviceToken);
    return {
      data: result,
    };
  }

  @Post('logout')
  @ApiOperation({ summary: 'Logout device' })
  @ApiHeader({ name: 'X-Device-Token', description: 'Device token', required: true })
  async logout(@Headers() headers: Record<string, string>) {
    const deviceToken = this.getDeviceToken(headers);
    await this.devicesService.logoutDevice(deviceToken);
    return {
      data: { success: true },
    };
  }
}
