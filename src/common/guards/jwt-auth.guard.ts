import {
  Injectable,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ALLOW_PENDING_TWO_FACTOR_KEY } from '../decorators/allow-pending-two-factor.decorator';
import { REQUIRES_SCOPE_KEY } from '../decorators/requires-scope.decorator';
import { ErrorCodes } from '../constants/error-codes';
import { ApiTokensService } from '../../modules/api-tokens/api-tokens.service';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private reflector: Reflector,
    private readonly apiTokensService: ApiTokensService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const vorgelegt = (request.headers?.authorization as string | undefined)?.replace(
      /^Bearer /i,
      '',
    );

    /* Ein API-Token statt eines Anmeldetokens. Die Unterscheidung faellt
       am Praefix, nicht am Ausprobieren: ein JWT durch die Token-Pruefung
       zu schicken (und umgekehrt) kostet bei jeder Anfrage eine
       Datenbankabfrage, die nie etwas findet. */
    if (ApiTokensService.istApiToken(vorgelegt)) {
      return this.pruefeApiToken(context, vorgelegt as string, request);
    }

    return (await super.canActivate(context)) as boolean;
  }

  /**
   * Ein API-Token erreicht nur, was ausdruecklich fuer ihn geoeffnet ist.
   *
   * Fail-closed: ohne @RequiresScope am Endpunkt ist Schluss, selbst wenn
   * der Besitzer des Tokens dort persoenlich alles duerfte. Sonst waere
   * ein Token fuers Ablesen von Zahlen zugleich ein Schluessel zu jeder
   * Organisation — der Besitzer ist ja Super-Admin.
   */
  private async pruefeApiToken(
    context: ExecutionContext,
    token: string,
    request: { user?: unknown; apiTokenScopes?: string[] },
  ): Promise<boolean> {
    const pruefung = await this.apiTokensService.pruefe(token);
    if (!pruefung) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Ungültiger oder abgelaufener API-Token',
      });
    }

    const verlangt = this.reflector.getAllAndOverride<string>(REQUIRES_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!verlangt) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Dieser Endpunkt ist für API-Tokens nicht freigegeben',
      });
    }

    if (!pruefung.scopes.includes(verlangt)) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: `API-Token fehlt die Berechtigung „${verlangt}"`,
      });
    }

    request.user = pruefung.user;
    request.apiTokenScopes = pruefung.scopes;
    return true;
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
