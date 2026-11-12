import { ForbiddenException } from '@nestjs/common';
import { ErrorCodes, ErrorReasons } from '../constants/error-codes';
import type { AppRequest } from '../types/request.types';

/**
 * Welche Organisation eine Anfrage anspricht.
 *
 * Massgeblich ist der Pfad: `organizations/:organizationId/...` bzw. die
 * Routen des Organisations-Controllers (`organizations/:id`, auch
 * `organizations/:id/waiters` usw.). Header `X-Organization-Id`, Query und
 * Rumpf (`organizationId`) sind nur Ersatz fuer Endpunkte ohne
 * Organisation im Pfad. Nennt die Anfrage mehrere Organisationen, muessen
 * alle dieselbe sein — sonst 403 ORGANIZATION_MISMATCH. So prueft ein Guard
 * nie eine andere Organisation als die, mit der der Controller arbeitet.
 */

/** Routenmuster, deren `:id` die Organisation ist. */
const ORGANIZATION_ID_ROUTE = /\/organizations\/:id(\/|$)/;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function routePath(request: AppRequest): string | undefined {
  return str((request as { route?: { path?: unknown } }).route?.path);
}

/** Die Organisation aus dem Pfad, falls die Route eine nennt. */
export function routeOrganizationId(request: AppRequest): string | undefined {
  const params = (request.params ?? {}) as Record<string, unknown>;
  const fromParam = str(params.organizationId);
  if (fromParam) return fromParam;
  const path = routePath(request);
  if (path && ORGANIZATION_ID_ROUTE.test(path)) {
    return str(params.id);
  }
  return undefined;
}

/** Organisation aus Header, Query und Rumpf (in dieser Reihenfolge). */
function otherOrganizationIds(request: AppRequest): string[] {
  const header = request.headers?.['x-organization-id'];
  const body = request.body as Record<string, unknown> | undefined;
  const query = request.query as Record<string, unknown> | undefined;
  const values: unknown[] = [
    // Mehrfach gesendete Header kommen als Liste — jeder Eintrag zaehlt.
    ...(Array.isArray(header) ? header : [header]),
    body && typeof body === 'object' ? body.organizationId : undefined,
    query?.organizationId,
  ];
  return values
    .map(str)
    .filter((value): value is string => value !== undefined);
}

export function organizationMismatch(): ForbiddenException {
  return new ForbiddenException({
    code: ErrorCodes.FORBIDDEN,
    reason: ErrorReasons.ORGANIZATION_MISMATCH,
    message: 'Die Anfrage nennt unterschiedliche Organisationen',
  });
}

/**
 * Die angesprochene Organisation: Pfad vor Header, Rumpf und Query.
 * Wirft 403 ORGANIZATION_MISMATCH, wenn die Angaben auseinandergehen.
 */
export function resolveRequestOrganizationId(
  request: AppRequest,
): string | undefined {
  const fromRoute = routeOrganizationId(request);
  const others = otherOrganizationIds(request);
  const first = fromRoute ?? others[0];
  if (first !== undefined && others.some((value) => value !== first)) {
    throw organizationMismatch();
  }
  return first;
}
