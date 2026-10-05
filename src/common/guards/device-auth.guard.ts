import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
  CanActivate,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Device } from '../../database/entities';
import { DeviceStatus } from '../../database/entities/device.entity';
import { ErrorCodes, ErrorReasons } from '../constants/error-codes';
import type { AppRequest } from '../types/request.types';

export const IS_DEVICE_AUTH_KEY = 'isDeviceAuth';

@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AppRequest>();
    const deviceToken = request.headers['x-device-token'] as string | undefined;

    if (!deviceToken) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        reason: ErrorReasons.DEVICE_TOKEN_MISSING,
        message: 'Device-Token fehlt',
      });
    }

    const device = await this.deviceRepository.findOne({
      where: { deviceToken, isActive: true },
      relations: ['organization'],
    });

    if (!device) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        reason: ErrorReasons.DEVICE_TOKEN_INVALID,
        message: 'Ungültiger Device-Token',
      });
    }

    if (device.status !== DeviceStatus.VERIFIED) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        reason: ErrorReasons.DEVICE_NOT_VERIFIED,
        message: 'Gerät ist nicht verifiziert',
      });
    }

    // Attach device to request for use in controllers
    request.device = device;

    // Update last seen
    await this.deviceRepository.update(device.id, { lastSeenAt: new Date() });

    return true;
  }
}
