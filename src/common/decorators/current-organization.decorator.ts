import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentOrganization = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest();

    // Try to get from header first
    const headerOrgId = request.headers['x-organization-id'];
    if (headerOrgId) {
      return headerOrgId;
    }

    // Then try from params
    if (request.params?.organizationId) {
      return request.params.organizationId;
    }

    // Then from body
    if (request.body?.organizationId) {
      return request.body.organizationId;
    }

    // Finally from query
    if (request.query?.organizationId) {
      return request.query.organizationId;
    }

    return undefined;
  },
);
