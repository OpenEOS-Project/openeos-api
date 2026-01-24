import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response, Request } from 'express';
import * as Sentry from '@sentry/nestjs';
import { ErrorCodes, ErrorMessages } from '../constants/error-codes';

interface ErrorDetail {
  field?: string;
  code?: string;
  message: string;
}

interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: ErrorDetail[];
    requestId?: string;
    timestamp: string;
  };
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const requestId = (request.headers['x-request-id'] as string) || response.getHeader('X-Request-Id') as string;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorCode: string = ErrorCodes.INTERNAL_ERROR;
    let message: string = ErrorMessages[ErrorCodes.INTERNAL_ERROR];
    let details: ErrorDetail[] | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'object') {
        const responseObj = exceptionResponse as Record<string, unknown>;

        // Check for custom error code
        if (responseObj.code && typeof responseObj.code === 'string') {
          errorCode = responseObj.code;
          message = (responseObj.message as string) || ErrorMessages[errorCode as keyof typeof ErrorMessages] || message;
        } else if (responseObj.message) {
          // Handle validation errors
          if (Array.isArray(responseObj.message)) {
            errorCode = ErrorCodes.VALIDATION_ERROR;
            message = 'Validierung fehlgeschlagen';
            details = responseObj.message.map((msg: string) => ({
              message: msg,
            }));
          } else {
            message = responseObj.message as string;
          }
        }

        // Preserve details if provided
        if (responseObj.details && Array.isArray(responseObj.details)) {
          details = responseObj.details as ErrorDetail[];
        }
      } else if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      }

      // Map status codes to error codes
      errorCode = this.mapStatusToErrorCode(status, errorCode);
    }

    // Log error
    if (status >= 500) {
      this.logger.error(
        `[${requestId}] ${request.method} ${request.url} - ${status} - ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );

      // Report 5xx errors to Sentry
      Sentry.withScope((scope) => {
        scope.setTag('url', request.url);
        scope.setTag('method', request.method);
        if (requestId) {
          scope.setTag('request_id', requestId);
        }
        const user = (request as Request & { user?: { id: string; email: string } }).user;
        if (user) {
          scope.setUser({ id: user.id, email: user.email });
        }
        Sentry.captureException(exception);
      });
    } else {
      this.logger.warn(`[${requestId}] ${request.method} ${request.url} - ${status} - ${message}`);
    }

    const errorResponse: ErrorResponse = {
      error: {
        code: errorCode,
        message,
        requestId,
        timestamp: new Date().toISOString(),
      },
    };

    if (details) {
      errorResponse.error.details = details;
    }

    response.status(status).json(errorResponse);
  }

  private mapStatusToErrorCode(status: HttpStatus, currentCode: string): string {
    // Wenn bereits ein spezifischer Code gesetzt ist, diesen beibehalten
    if (currentCode !== ErrorCodes.INTERNAL_ERROR) {
      return currentCode;
    }

    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ErrorCodes.VALIDATION_ERROR;
      case HttpStatus.UNAUTHORIZED:
        return ErrorCodes.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ErrorCodes.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ErrorCodes.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ErrorCodes.CONFLICT;
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return ErrorCodes.VALIDATION_ERROR;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCodes.RATE_LIMITED;
      default:
        return ErrorCodes.INTERNAL_ERROR;
    }
  }
}
