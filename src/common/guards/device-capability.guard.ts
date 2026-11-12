import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  DeviceCapabilityName,
  deviceCan,
} from '../constants/device-capabilities';
import { DEVICE_CAPABILITY_KEY } from '../decorators/device-capability.decorator';
import { ErrorCodes, ErrorReasons } from '../constants/error-codes';
import type { AppRequest } from '../types/request.types';

/**
 * Nach dem DeviceAuthGuard: der Geraetetyp muss die Faehigkeit haben, die
 * der Endpunkt mit `@DeviceCapability` verlangt. Endpunkte ohne Angabe
 * lehnt er ab.
 */
@Injectable()
export class DeviceCapabilityGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AppRequest>();
    const device = request.device;
    if (!device) return false;
    const capability = this.reflector.getAllAndOverride<
      DeviceCapabilityName | undefined
    >(DEVICE_CAPABILITY_KEY, [context.getHandler(), context.getClass()]);
    if (capability && deviceCan(device, capability)) return true;
    throw new ForbiddenException({
      code: ErrorCodes.FORBIDDEN,
      reason: ErrorReasons.DEVICE_TYPE_NOT_ALLOWED,
      message: 'Dieser Gerätetyp kann diese Funktion nicht nutzen.',
    });
  }
}
