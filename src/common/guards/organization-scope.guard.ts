import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { AppRequest } from '../types/request.types';
import {
  resolveRequestOrganizationId,
  routeOrganizationId,
} from '../utils/request-organization.util';

/**
 * Global: Nennt die Route eine Organisation im Pfad, duerfen Header
 * `X-Organization-Id`, Query und Rumpf keine andere nennen (403
 * ORGANIZATION_MISMATCH). Die Controller arbeiten mit dem Pfad; ein
 * abweichender Header waere bestenfalls ein Client-Fehler.
 */
@Injectable()
export class OrganizationScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<AppRequest>();
    if (routeOrganizationId(request) !== undefined) {
      resolveRequestOrganizationId(request);
    }
    return true;
  }
}
