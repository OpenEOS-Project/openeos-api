import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ErrorCodes } from '../constants/error-codes';

@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.isSuperAdmin) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Super-Admin-Berechtigung erforderlich',
      });
    }

    return true;
  }
}
