import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ALLOW_PENDING_TWO_FACTOR_KEY } from '../decorators/allow-pending-two-factor.decorator';
import { ErrorCodes } from '../constants/error-codes';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    return super.canActivate(context);
  }

  handleRequest<TUser>(
    err: Error | null,
    user: TUser,
    info: Error | null,
    context?: ExecutionContext,
  ): TUser {
    if (err || !user) {
      if (info?.name === 'TokenExpiredError') {
        throw new UnauthorizedException({
          code: ErrorCodes.TOKEN_EXPIRED,
          message: 'Token abgelaufen',
        });
      }
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Nicht authentifiziert',
      });
    }

    /* Der Ausweis aus dem ersten Anmeldeschritt oeffnet nur die Tuer zum
       zweiten. Ueberall sonst gilt er als nicht angemeldet — sonst waere
       das Passwort allein wieder der ganze Zugang. */
    const stehtAus = (user as { pending2fa?: boolean })?.pending2fa === true;
    if (stehtAus) {
      const erlaubt = context
        ? this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_TWO_FACTOR_KEY, [
            context.getHandler(),
            context.getClass(),
          ])
        : false;
      if (!erlaubt) {
        throw new UnauthorizedException({
          code: ErrorCodes.UNAUTHORIZED,
          message: 'Zweiter Faktor steht noch aus',
        });
      }
    }

    return user;
  }
}
