import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AppRequest } from '../types/request.types';
import { resolveRequestOrganizationId } from '../utils/request-organization.util';

/**
 * ID der angesprochenen Organisation — dieselbe, die OrganizationGuard und
 * RolesGuard pruefen: der Pfad zuerst, Header/Rumpf/Query nur ohne Pfad,
 * widersprechende Angaben ergeben 403.
 */
export const CurrentOrganization = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest<AppRequest>();
    return resolveRequestOrganizationId(request);
  },
);
