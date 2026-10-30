import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';

import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import type { AppRequest } from '../../common/types/request.types';
import {
  alsBenutzer,
  alsRequestToken,
  ungueltigerApiToken,
} from '../api-tokens/api-token-auth';
import { ApiTokensService } from '../api-tokens/api-tokens.service';
import { resourceMetadataUrl } from './mcp.constants';

/**
 * Anmeldung am MCP-Endpunkt: nur mit API-Token (`Bearer oeos_…`), nie
 * mit einer Sitzung.
 *
 * Dieselbe Pruefung wie im JwtAuthGuard (Token gueltig, Besitzer aktiv
 * und Mitglied), ohne die Endpunkt-Freigabe — welche Werkzeuge der Token
 * sieht und aufrufen darf, entscheiden seine Scopes in der Registry.
 * Bei 401 steht im `WWW-Authenticate`-Header, wo die Metadaten der
 * geschuetzten Ressource liegen (RFC 9728), damit MCP-Clients den Weg zur
 * Anmeldung finden — OAuth selbst folgt in Phase 3.
 */
@Injectable()
export class McpAuthGuard implements CanActivate {
  constructor(private readonly apiTokens: ApiTokensService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<AppRequest>();
    const response = http.getResponse<Response>();

    const vorgelegt = request.headers?.authorization?.replace(/^Bearer /i, '');
    if (!vorgelegt) {
      throw this.challenge(request, response, false);
    }
    if (!ApiTokensService.istApiToken(vorgelegt)) {
      throw this.challenge(request, response, true);
    }

    const pruefung = await this.apiTokens.pruefe(vorgelegt);
    if (!pruefung) {
      throw this.challenge(request, response, true);
    }
    if (!pruefung.token.organizationId) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.API_TOKEN_WRONG_ORGANIZATION,
        message: 'Plattform-Tokens können den MCP-Server nicht nutzen',
      });
    }

    request.user = alsBenutzer(pruefung);
    request.apiToken = alsRequestToken(pruefung);
    request.organizationId = pruefung.token.organizationId;
    return true;
  }

  private challenge(
    request: AppRequest,
    response: Response,
    tokenPresented: boolean,
  ): UnauthorizedException {
    response.setHeader(
      'WWW-Authenticate',
      `Bearer resource_metadata="${resourceMetadataUrl(request)}"`,
    );
    if (tokenPresented) return ungueltigerApiToken();
    return new UnauthorizedException({
      code: ErrorCodes.UNAUTHORIZED,
      reason: ErrorReasons.NOT_AUTHENTICATED,
      message: 'API-Token nötig: Authorization: Bearer oeos_…',
    });
  }
}
