import {
  applyDecorators,
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import type { AppRequest } from '../../common/types/request.types';
import type { Operator } from './waiter-operator';
import { WaiterSessionsService } from './waiter-sessions.service';

export const WAITER_SESSION_HEADER = 'x-waiter-session';

/**
 * Bedienungs-Sitzung fuer schreibende Geraete-Endpunkte (nach
 * DeviceAuthGuard). Legt `request.operator` an: die feste Bedienung
 * (`personal`), die angemeldete Bedienung bzw. das Mitglied (`shared`,
 * Pflicht) oder null (`off`, ohne Token).
 */
@Injectable()
export class WaiterSessionGuard implements CanActivate {
  constructor(private readonly sessions: WaiterSessionsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AppRequest>();
    const device = request.device;
    if (!device) return true; // DeviceAuthGuard hat schon abgelehnt
    const header = request.headers[WAITER_SESSION_HEADER];
    const token = Array.isArray(header) ? header[0] : header;
    request.operator = await this.sessions.operatorForRequest(
      device,
      token || undefined,
    );
    return true;
  }
}

/** Schreibender Geraete-Endpunkt: Bedienungs-Sitzung je nach Geraetemodus. */
export function WithOperator() {
  return applyDecorators(
    UseGuards(WaiterSessionGuard),
    ApiHeader({
      name: 'X-Waiter-Session',
      required: false,
      description:
        'Token der Bedienungs-Sitzung (POST /device-api/waiter-session). Pflicht, wenn das Gerät im Modus „gemeinsame Kasse“ (`waiterMode: shared`) läuft; sonst 403 WAITER_SESSION_REQUIRED.',
    }),
  );
}

/** Wer bucht (aus der Sitzung), null ohne Bedienung. */
export const CurrentOperator = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Operator | null => {
    const request = ctx.switchToHttp().getRequest<AppRequest>();
    return request.operator ?? null;
  },
);
