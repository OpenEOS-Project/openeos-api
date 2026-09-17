import {
  Controller,
  Post,
  Get,
  Body,
  Headers,
  Query,
  BadRequestException,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader, ApiQuery } from '@nestjs/swagger';
import { DevicesService } from './devices.service';
import { RegisterDeviceDto, InitDeviceDto, LinkDeviceDto } from './dto';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../../database/entities';
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

  @Post('init')
  @ApiOperation({
    summary: 'Step 1 — register a device and get its pairing code',
    description: [
      'Start here for any client that cannot ask for credentials: a TV, a',
      'tablet, an app. No organisation is needed and none is assigned yet.',
      '',
      'Returns a deviceToken (keep it, it is the long-lived credential) and',
      'a six-digit verificationCode. Show the code to the user and poll',
      'GET /devices/status with the token until it reports "verified".',
      '',
      'Someone signed in then links the code — see POST /devices/link.',
      'Until then the device has no access to anything.',
    ].join(' '),
  })
  async initDevice(@Body() initDto: InitDeviceDto) {
    const result = await this.devicesService.initDevice(initDto);
    return {
      data: result,
    };
  }

  @Get('lookup')
  @ApiOperation({
    summary: 'Step 2 — look up which device a code belongs to',
    description:
      'Public on purpose: it only reveals the suggested name and user agent ' +
      'of a device that is already waiting, which whoever holds the code can ' +
      'read off its screen anyway. Codes are unique among pending devices.',
  })
  @ApiQuery({ name: 'code', description: '6-digit verification code', required: true })
  async lookupByCode(@Query('code') code: string) {
    if (!code || code.length !== 6) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Ungültiger Verifizierungscode',
      });
    }

    const result = await this.devicesService.findByVerificationCode(code);
    if (!result) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Gerät nicht gefunden oder bereits verknüpft',
      });
    }

    return {
      data: result,
    };
  }

  @Post('register')
  @ApiOperation({ summary: 'Register a new device (legacy - requires organization slug)' })
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
