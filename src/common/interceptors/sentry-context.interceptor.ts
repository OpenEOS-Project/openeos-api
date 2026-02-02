import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import * as Sentry from '@sentry/nestjs';
import type { Request } from 'express';

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
  };
}

@Injectable()
export class SentryContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    Sentry.withScope((scope) => {
      // Set user context
      if (request.user) {
        scope.setUser({
          id: request.user.id,
          email: request.user.email,
        });
      }

      // Set organization context
      const organizationId = request.headers['x-organization-id'] as string;
      if (organizationId) {
        scope.setTag('organization_id', organizationId);
      }

      // Set request ID for correlation
      const requestId = request.headers['x-request-id'] as string;
      if (requestId) {
        scope.setTag('request_id', requestId);
      }

      // Set device context if present
      const deviceId = request.headers['x-device-id'] as string;
      if (deviceId) {
        scope.setTag('device_id', deviceId);
      }
    });

    return next.handle();
  }
}
