import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiBearerAuth, ApiExtension } from '@nestjs/swagger';

import type { TokenScope } from '../../modules/api-tokens/api-scopes';

export const API_TOKEN_ACCESS_KEY = 'apiTokenAccess';

/** Name des Sicherheitsschemas in der OpenAPI-Beschreibung. */
export const API_TOKEN_SECURITY_SCHEME = 'API-token';

/**
 * Öffnet einen Endpunkt für API-Tokens — und nur für solche mit diesem
 * Geltungsbereich.
 *
 * Ohne diese Markierung weist der Guard jeden API-Token ab
 * (`API_TOKEN_NOT_ALLOWED`). Das ist die wichtigere Hälfte der Regel: Ein
 * Token zum Pflegen der Speisekarte soll nicht nebenbei Mitglieder
 * verwalten oder Erstattungen auslösen können, nur weil sein Besitzer das
 * dürfte. Die Positivliste steht damit im Code neben dem Endpunkt und
 * landet über `x-api-token-scope` auch in der OpenAPI-Beschreibung.
 */
export const ApiTokenAccess = (scope: TokenScope) =>
  applyDecorators(
    SetMetadata(API_TOKEN_ACCESS_KEY, scope),
    ApiBearerAuth(API_TOKEN_SECURITY_SCHEME),
    ApiExtension('x-api-token-scope', scope),
  );
