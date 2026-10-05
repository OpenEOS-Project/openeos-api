import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { RequestUser } from '../decorators/current-user.decorator';
import { ErrorCodes, ErrorReasons } from '../constants/error-codes';
import type { AppRequest } from '../types/request.types';

@Injectable()
export class OrganizationGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AppRequest>();
    const user = request.user as RequestUser;

    if (!user) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.NOT_AUTHENTICATED,
        message: 'Nicht authentifiziert',
      });
    }

    // Superadmin hat Zugriff auf alle Organisationen
    if (user.isSuperAdmin) {
      return true;
    }

    const organizationId = this.getOrganizationId(request);
    if (!organizationId) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.ORGANIZATION_NOT_SPECIFIED,
        message: 'Organisation nicht angegeben',
      });
    }

    // Prüfe ob der User Mitglied der Organisation ist
    const isMember = user.organizations?.some((o) => o.id === organizationId);
    if (!isMember) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.NOT_ORGANIZATION_MEMBER,
        message: 'Kein Mitglied dieser Organisation',
      });
    }

    // Füge die organizationId zur Request hinzu für spätere Verwendung
    request.organizationId = organizationId;

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
