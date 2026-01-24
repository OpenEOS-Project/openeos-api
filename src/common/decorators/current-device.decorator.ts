import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Device } from '../../database/entities';

export const CurrentDevice = createParamDecorator(
  (data: keyof Device | undefined, ctx: ExecutionContext): Device | unknown => {
    const request = ctx.switchToHttp().getRequest();
    const device = request.device as Device;

    if (data) {
      return device?.[data];
    }

    return device;
  },
);
