import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { RequestUser } from '../decorators/current-user.decorator';
import { ErrorCodes } from '../constants/error-codes';

@Injectable()
export class OrganizationGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user as RequestUser;

    if (!user) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Nicht authentifiziert',
      });
    }

    // Superadmin hat Zugriff auf alle Organisationen
    if (user.isSuperadmin) {
      return true;
    }

    const organizationId = this.getOrganizationId(request);
    if (!organizationId) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Organisation nicht angegeben',
      });
    }

    // Prüfe ob der User Mitglied der Organisation ist
    const isMember = user.organizations?.some((o) => o.id === organizationId);
    if (!isMember) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Kein Mitglied dieser Organisation',
      });
    }

    // Füge die organizationId zur Request hinzu für spätere Verwendung
    request.organizationId = organizationId;

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
