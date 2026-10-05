import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { Role, hasRole } from '../constants/roles.enum';
import { RequestUser } from '../decorators/current-user.decorator';
import { ErrorCodes, ErrorReasons } from '../constants/error-codes';
import type { AppRequest } from '../types/request.types';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AppRequest>();
    const user = request.user as RequestUser;

    if (!user) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.INSUFFICIENT_PERMISSIONS,
        message: 'Keine Berechtigung',
      });
    }

    // Superadmin hat alle Rechte
    if (user.isSuperAdmin) {
      return true;
    }

    // Prüfe ob der User eine der benötigten Rollen hat
    const organizationId = this.getOrganizationId(request);
    if (!organizationId) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.ORGANIZATION_NOT_SPECIFIED,
        message: 'Organisation nicht angegeben',
      });
    }

    const userOrg = user.organizations?.find((o) => o.id === organizationId);
    if (!userOrg) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.NOT_ORGANIZATION_MEMBER,
        message: 'Kein Mitglied dieser Organisation',
      });
    }

    const hasRequiredRole = requiredRoles.some((role) =>
      hasRole(userOrg.role as Role, role),
    );

    if (!hasRequiredRole) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.INSUFFICIENT_PERMISSIONS,
        message: 'Keine ausreichende Berechtigung',
      });
    }

    return true;
  }

  private getOrganizationId(request: AppRequest): string | undefined {
    const body = request.body as Record<string, unknown> | undefined;
    return (
      (request.headers['x-organization-id'] as string | undefined) ||
      request.params?.organizationId ||
      (body?.organizationId as string) ||
      (request.query?.organizationId as string | undefined)
    );
  }
}
