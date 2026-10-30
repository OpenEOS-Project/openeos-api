import {
  Injectable,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ALLOW_PENDING_TWO_FACTOR_KEY } from '../decorators/allow-pending-two-factor.decorator';
import { API_TOKEN_ACCESS_KEY } from '../decorators/api-token-access.decorator';
import { ErrorCodes, ErrorReasons } from '../constants/error-codes';
import {
  ApiTokensService,
  type TokenPruefung,
} from '../../modules/api-tokens/api-tokens.service';
import {
  alsBenutzer,
  alsRequestToken,
  ungueltigerApiToken,
} from '../../modules/api-tokens/api-token-auth';
import type { AppRequest } from '../types/request.types';

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

    const request = context.switchToHttp().getRequest<AppRequest>();
    const vorgelegt = request.headers?.authorization?.replace(/^Bearer /i, '');

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
   * Reihenfolge der Pruefungen, alle fail-closed:
   * 1. Token gueltig (nicht widerrufen/abgelaufen, Besitzer aktiv und
   *    noch Mitglied der Organisation) — sonst 401.
   * 2. Endpunkt traegt @ApiTokenAccess — sonst 403 API_TOKEN_NOT_ALLOWED,
   *    selbst wenn der Besitzer dort persoenlich alles duerfte.
   * 3. Token traegt den verlangten Scope — sonst 403 API_TOKEN_SCOPE_MISSING.
   * 4. Die angesprochene Organisation ist die des Tokens — sonst 403
   *    API_TOKEN_WRONG_ORGANIZATION. Plattform-Tokens (ohne Organisation)
   *    duerfen keine Organisation ansprechen.
   *
   * Danach wirkt die Anfrage wie der Besitzer, aber nur in dieser einen
   * Organisation: `user.organizations` enthaelt allein die Token-Organisation,
   * die Dienste pruefen Rolle und Modul-Berechtigungen wie sonst auch.
   */
  private async pruefeApiToken(
    context: ExecutionContext,
    token: string,
    request: AppRequest,
  ): Promise<boolean> {
    const pruefung = await this.apiTokensService.pruefe(token);
    if (!pruefung) {
      throw ungueltigerApiToken();
    }

    const verlangt = this.reflector.getAllAndOverride<string>(
      API_TOKEN_ACCESS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!verlangt) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.API_TOKEN_NOT_ALLOWED,
        message: 'Dieser Endpunkt ist für API-Tokens nicht freigegeben',
      });
    }

    if (!pruefung.scopes.includes(verlangt)) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.API_TOKEN_SCOPE_MISSING,
        message: `API-Token fehlt die Berechtigung „${verlangt}“`,
        params: { scope: verlangt },
      });
    }

    await this.pruefeOrganisation(request, pruefung);

    request.user = alsBenutzer(pruefung);
    request.apiToken = alsRequestToken(pruefung);
    return true;
  }

  /**
   * Jede Organisation, die die Anfrage nennt (Pfad, Header, Rumpf,
   * Query), muss die des Tokens sein. Endpunkte unter `events/:eventId`
   * nennen keine — dort entscheidet die Veranstaltung.
   */
  private async pruefeOrganisation(
    request: AppRequest,
    pruefung: TokenPruefung,
  ): Promise<void> {
    const tokenOrg = pruefung.token.organizationId;
    const genannt = this.genannteOrganisationen(request);

    /* Plattform-Tokens (Monitoring) haben keine Organisation und duerfen
       auch keine ansprechen. */
    if (tokenOrg === null) {
      if (genannt.size > 0 || request.params?.eventId) {
        throw this.falscheOrganisation();
      }
      return;
    }

    if (request.params?.eventId && genannt.size === 0) {
      const eventOrg = await this.apiTokensService.organizationOfEvent(
        request.params.eventId,
      );
      if (!eventOrg) {
        throw new NotFoundException({
          code: ErrorCodes.NOT_FOUND,
          reason: ErrorReasons.EVENT_NOT_FOUND,
          message: 'Veranstaltung nicht gefunden',
        });
      }
      genannt.add(eventOrg);
    }

    const passt =
      genannt.size > 0 && [...genannt].every((id) => id === tokenOrg);
    if (!passt) {
      throw this.falscheOrganisation();
    }

    request.organizationId = tokenOrg;
  }

  private falscheOrganisation(): ForbiddenException {
    return new ForbiddenException({
      code: ErrorCodes.FORBIDDEN,
      reason: ErrorReasons.API_TOKEN_WRONG_ORGANIZATION,
      message: 'Der API-Token gilt nicht für diese Organisation',
    });
  }

  private genannteOrganisationen(request: AppRequest): Set<string> {
    const body = request.body as Record<string, unknown> | undefined;
    const kandidaten: unknown[] = [
      request.headers?.['x-organization-id'],
      request.params?.organizationId,
      body?.organizationId,
      request.query?.organizationId,
    ];
    /* `organizations/:id` — der einzige Controller, der die Organisation
       `id` nennt. Erkannt am Routenmuster, nicht an einem beliebigen `id`. */
    const route = (request as { route?: { path?: string } }).route?.path;
    if (route && /\/organizations\/:id(\/|$)/.test(route)) {
      kandidaten.push(request.params?.id);
    }
    return new Set(
      kandidaten.filter(
        (wert): wert is string => typeof wert === 'string' && wert.length > 0,
      ),
    );
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
        reason: ErrorReasons.NOT_AUTHENTICATED,
        message: 'Nicht authentifiziert',
      });
    }

    /* Der Ausweis aus dem ersten Anmeldeschritt oeffnet nur die Tuer zum
       zweiten. Ueberall sonst gilt er als nicht angemeldet — sonst waere
       das Passwort allein wieder der ganze Zugang. */
    const stehtAus = (user as { pending2fa?: boolean })?.pending2fa === true;
    if (stehtAus) {
      const erlaubt = context
        ? this.reflector.getAllAndOverride<boolean>(
            ALLOW_PENDING_TWO_FACTOR_KEY,
            [context.getHandler(), context.getClass()],
          )
        : false;
      if (!erlaubt) {
        throw new UnauthorizedException({
          code: ErrorCodes.UNAUTHORIZED,
          reason: ErrorReasons.TWO_FACTOR_PENDING,
          message: 'Zweiter Faktor steht noch aus',
        });
      }
    }

    return user;
  }
}
