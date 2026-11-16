import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  OrganizationRole,
  UserOrganization,
} from '../../database/entities/user-organization.entity';
import { ErrorCodes, ErrorReasons } from '../constants/error-codes';
import { ORGANIZATION_PERMISSION_KEY } from '../decorators/requires-organization-permission.decorator';
import type { AppRequest } from '../types/request.types';
import { resolveRequestOrganizationId } from '../utils/request-organization.util';

/**
 * Prueft die Modul-Berechtigung (@RequiresOrganizationPermission) in der
 * Organisation aus dem Pfad. Die Mitgliedschaft kommt frisch aus der
 * Datenbank — Rechte, die ein Admin gerade entzogen hat, gelten sofort.
 * Super-Admins und Administratoren der Organisation duerfen alles.
 */
@Injectable()
export class OrganizationPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.getAllAndOverride<string | undefined>(
      ORGANIZATION_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!permission) return true;

    const request = context.switchToHttp().getRequest<AppRequest>();
    const user = request.user;
    if (!user) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.NOT_AUTHENTICATED,
        message: 'Nicht authentifiziert',
      });
    }
    if (user.isSuperAdmin) return true;

    const organizationId = resolveRequestOrganizationId(request);
    if (!organizationId) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.ORGANIZATION_NOT_SPECIFIED,
        message: 'Organisation nicht angegeben',
      });
    }

    const membership = await this.dataSource
      .getRepository(UserOrganization)
      .findOne({ where: { userId: user.id, organizationId } });
    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.NOT_ORGANIZATION_MEMBER,
        message: 'Kein Mitglied dieser Organisation',
      });
    }
    if (membership.role === OrganizationRole.ADMIN) return true;

    const permissions = (membership.permissions ?? {}) as Record<
      string,
      boolean | undefined
    >;
    if (permissions[permission] !== true) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.INSUFFICIENT_PERMISSIONS,
        message: 'Keine ausreichenden Berechtigungen',
        params: { permission },
      });
    }
    return true;
  }
}
