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
import { reportUser, stripQueryString } from '../utils/sentry-scrub.util';

interface ErrorDetail {
  field?: string;
  code?: string;
  message: string;
}

type ErrorParams = Record<string, string | number | boolean>;

/**
 * Body of every error response.
 *
 * - `code`: general error class (VALIDATION_ERROR, NOT_FOUND, …) — stable,
 *   existing clients branch on it.
 * - `reason`: optional, the specific case (e.g. SHIFT_NOT_FOUND, see
 *   ErrorReasons). Clients translate `reason` first, then `code`.
 * - `message`: German text, kept as fallback for clients without
 *   translations.
 * - `params`: optional values contained in `message` (names, amounts,
 *   limits) so clients can build their own sentence.
 * - `details`: per-field validation errors (`field`, `code`, `message`) or
 *   upstream information (e.g. SUMUP_HTTP_401).
 */
export interface ErrorResponse {
  error: {
    code: string;
    reason?: string;
    message: string;
    params?: ErrorParams;
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

    const requestId =
      (request.headers['x-request-id'] as string) ||
      (response.getHeader('X-Request-Id') as string);

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorCode: string = ErrorCodes.INTERNAL_ERROR;
    let message: string = ErrorMessages[ErrorCodes.INTERNAL_ERROR];
    let details: ErrorDetail[] | undefined;
    let reason: string | undefined;
    let params: ErrorParams | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'object') {
        const responseObj = exceptionResponse as Record<string, unknown>;

        // Check for custom error code
        if (responseObj.code && typeof responseObj.code === 'string') {
          errorCode = responseObj.code;
          message =
            (responseObj.message as string) ||
            ErrorMessages[errorCode as keyof typeof ErrorMessages] ||
            message;
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

        if (typeof responseObj.reason === 'string' && responseObj.reason) {
          reason = responseObj.reason;
        }
        params = this.pickParams(responseObj.params);
      } else if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      }

      // Map status codes to error codes
      errorCode = this.mapStatusToErrorCode(status, errorCode);
    }

    // Log error
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `[${requestId}] ${request.method} ${request.url} - ${status} - ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );

      // Report 5xx errors to Sentry
      Sentry.withScope((scope) => {
        scope.setTag('url', stripQueryString(request.url));
        scope.setTag('method', request.method);
        if (requestId) {
          scope.setTag('request_id', requestId);
        }
        // Nur die Nutzer-ID — keine E-Mail, keine IP.
        const user = reportUser(
          (request as Request & { user?: { id: string } }).user,
        );
        if (user) {
          scope.setUser(user);
        }
        Sentry.captureException(exception);
      });
    } else {
      /* Guards laufen vor dem Logging-Interceptor: bei 401/403 gibt es
         deshalb keine zweite Zeile mit IP und Client, und die Anfrage-Nummer
         ist "undefined". Ohne diese Angaben liess sich eine Schleife aus
         tausenden 401 keinem Geraet zuordnen. */
      const herkunft =
        status === HttpStatus.UNAUTHORIZED || status === HttpStatus.FORBIDDEN
          ? ` - IP: ${request.ip} - UA: ${String(request.headers['user-agent'] ?? '').slice(0, 80)}`
          : '';
      this.logger.warn(
        `[${requestId}] ${request.method} ${request.url} - ${status} - ${message}${herkunft}`,
      );
      if (details && details.length > 0) {
        this.logger.warn(
          `[${requestId}] Validation details: ${JSON.stringify(details)}`,
        );
      }
    }

    const errorResponse: ErrorResponse = {
      error: {
        code: errorCode,
        ...(reason ? { reason } : {}),
        message,
        ...(params ? { params } : {}),
        requestId,
        timestamp: new Date().toISOString(),
      },
    };

    if (details) {
      errorResponse.error.details = details;
    }

    response.status(status).json(errorResponse);
  }

  /** Only flat primitive values; anything else is dropped. */
  private pickParams(value: unknown): ErrorParams | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    const picked: ErrorParams = {};
    for (const [key, entry] of Object.entries(value)) {
      if (
        typeof entry === 'string' ||
        typeof entry === 'number' ||
        typeof entry === 'boolean'
      ) {
        picked[key] = entry;
      }
    }
    return Object.keys(picked).length > 0 ? picked : undefined;
  }

  private mapStatusToErrorCode(
    status: HttpStatus,
    currentCode: string,
  ): string {
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
