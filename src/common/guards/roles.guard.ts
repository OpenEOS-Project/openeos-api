import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { Role, hasRole } from '../constants/roles.enum';
import { RequestUser } from '../decorators/current-user.decorator';
import { ErrorCodes } from '../constants/error-codes';

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

    const request = context.switchToHttp().getRequest();
    const user = request.user as RequestUser;

    if (!user) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Keine Berechtigung',
      });
    }

    // Superadmin hat alle Rechte
    if (user.isSuperadmin) {
      return true;
    }

    // Prüfe ob der User eine der benötigten Rollen hat
    const organizationId = this.getOrganizationId(request);
    if (!organizationId) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Organisation nicht angegeben',
      });
    }

    const userOrg = user.organizations?.find((o) => o.id === organizationId);
    if (!userOrg) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Kein Mitglied dieser Organisation',
      });
    }

    const hasRequiredRole = requiredRoles.some((role) =>
      hasRole(userOrg.role as Role, role),
    );

    if (!hasRequiredRole) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Keine ausreichende Berechtigung',
      });
    }

    return true;
  }

  private getOrganizationId(request: Request & { params?: Record<string, string>; body?: Record<string, unknown>; query?: Record<string, string>; headers: Record<string, string> }): string | undefined {
    return (
      request.headers['x-organization-id'] ||
      request.params?.organizationId ||
      (request.body?.organizationId as string) ||
      request.query?.organizationId
    );
  }
}
