import { UnauthorizedException } from '@nestjs/common';

import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import type { RequestUser } from '../../common/decorators/current-user.decorator';
import type { RequestApiToken } from '../../common/types/request.types';
import type { TokenPruefung } from './api-tokens.service';

/**
 * Gemeinsame Stuecke der Token-Anmeldung — fuer den JwtAuthGuard (REST)
 * und den MCP-Endpunkt, damit ein Token an beiden Stellen dieselbe
 * Person mit denselben Grenzen ist.
 */

/** 401 fuer alles, was nicht stimmt — ohne zu verraten, was genau. */
export function ungueltigerApiToken(): UnauthorizedException {
  return new UnauthorizedException({
    code: ErrorCodes.UNAUTHORIZED,
    reason: ErrorReasons.API_TOKEN_INVALID,
    message: 'Ungültiger oder abgelaufener API-Token',
  });
}

/** Der Besitzer, beschraenkt auf die Organisation des Tokens. */
export function alsBenutzer(pruefung: TokenPruefung): RequestUser {
  const { user, membership, token } = pruefung;
  const organizations =
    membership && token.organizationId
      ? [{ id: token.organizationId, role: membership.role }]
      : [];
  return Object.assign(user, {
    organizations,
    sessionId: null,
    pending2fa: false,
  }) as unknown as RequestUser;
}

/** Was `request.apiToken` traegt. */
export function alsRequestToken(pruefung: TokenPruefung): RequestApiToken {
  return { ...pruefung.token, scopes: pruefung.scopes };
}
