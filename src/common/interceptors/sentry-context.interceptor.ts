import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import * as Sentry from '@sentry/nestjs';
import type { Request } from 'express';
import { reportUser } from '../utils/sentry-scrub.util';

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
  };
}

@Injectable()
export class SentryContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    Sentry.withScope((scope) => {
      // Set user context — nur die Nutzer-ID, keine E-Mail, keine IP.
      const user = reportUser(request.user);
      if (user) {
        scope.setUser(user);
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
