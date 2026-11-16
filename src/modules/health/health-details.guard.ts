import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { createHash, timingSafeEqual } from 'crypto';

import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import type { AppRequest } from '../../common/types/request.types';

export const HEALTH_TOKEN_HEADER = 'x-health-token';

function sameToken(given: string, expected: string): boolean {
  // Gleich lange Werte vergleichen, damit die Laufzeit nichts verraet.
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Ausfuehrlicher Gesundheitsstatus (Speicher, Laufzeiten der Pruefungen):
 * nur fuer Super-Admins oder mit dem internen Token aus
 * `HEALTH_DETAILS_TOKEN` im Kopf `X-Health-Token` (fuer Monitoring ohne
 * Anmeldung). Ohne gesetztes Token bleibt nur der Weg ueber Super-Admins.
 */
@Injectable()
export class HealthDetailsGuard extends AuthGuard('jwt') {
  constructor(private readonly config: ConfigService) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AppRequest>();
    const expected = this.config.get<string>('HEALTH_DETAILS_TOKEN');
    const given = request.headers?.[HEALTH_TOKEN_HEADER];
    if (expected && typeof given === 'string' && given.length > 0) {
      if (sameToken(given, expected)) return true;
      throw this.denied();
    }

    await super.canActivate(context);
    if (!request.user?.isSuperAdmin) throw this.denied();
    return true;
  }

  private denied(): ForbiddenException {
    return new ForbiddenException({
      code: ErrorCodes.FORBIDDEN,
      reason: ErrorReasons.SUPER_ADMIN_REQUIRED,
      message: 'Super-Admin-Berechtigung erforderlich',
    });
  }
}
