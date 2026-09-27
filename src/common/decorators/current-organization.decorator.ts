import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AppRequest } from '../types/request.types';

export const CurrentOrganization = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest<AppRequest>();

    // Try to get from header first
    const headerOrgId = request.headers['x-organization-id'];
    if (headerOrgId) {
      return headerOrgId as string;
    }

    // Then try from params
    if (request.params?.organizationId) {
      return request.params.organizationId;
    }

    // Then from body — der Rumpf ist ungeprueftes JSON, daher `unknown`
    const body = request.body as Record<string, unknown> | undefined;
    if (body?.organizationId) {
      return body.organizationId as string;
    }

    // Finally from query
    if (request.query?.organizationId) {
      return request.query.organizationId as string;
    }

    return undefined;
  },
);
