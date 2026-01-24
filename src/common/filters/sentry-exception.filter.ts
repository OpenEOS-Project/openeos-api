import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import type { Request } from 'express';

@Catch()
export class SentryExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();

    // Determine if this is a server error (5xx) or client error (4xx)
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    // Only report server errors (5xx) to Sentry
    // Client errors (4xx) are expected behavior and shouldn't be tracked as errors
    if (status >= 500) {
      Sentry.withScope((scope) => {
        // Add request context
        scope.setTag('url', request.url);
        scope.setTag('method', request.method);

        // Add request ID if available
        const requestId = request.headers['x-request-id'] as string;
        if (requestId) {
          scope.setTag('request_id', requestId);
        }

        // Add organization context if available
        const organizationId = request.headers['x-organization-id'] as string;
        if (organizationId) {
          scope.setTag('organization_id', organizationId);
        }

        // Add user context if available (from JWT)
        const user = (request as Request & { user?: { id: string; email: string } }).user;
        if (user) {
          scope.setUser({
            id: user.id,
            email: user.email,
          });
        }

        // Add additional context
        scope.setContext('request', {
          url: request.url,
          method: request.method,
          headers: {
            'user-agent': request.headers['user-agent'],
            'content-type': request.headers['content-type'],
          },
          query: request.query,
          // Don't include body for security reasons (might contain passwords)
        });

        // Capture the exception
        Sentry.captureException(exception);
      });
    }

    // Re-throw the exception to let other filters handle it
    throw exception;
  }
}
