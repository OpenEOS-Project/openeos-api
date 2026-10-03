import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Device } from '../../database/entities';
import type { AppRequest } from '../types/request.types';

export const CurrentDevice = createParamDecorator(
  (data: keyof Device | undefined, ctx: ExecutionContext): unknown => {
    const request = ctx.switchToHttp().getRequest<AppRequest>();
    const device = request.device as Device;

    if (data) {
      return device?.[data];
    }

    return device;
  },
);
