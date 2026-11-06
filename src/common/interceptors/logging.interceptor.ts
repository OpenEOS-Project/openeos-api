import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Request, Response } from 'express';

import { stripQueryString } from '../utils/sentry-scrub.util';

const HEALTH_PATH = /^\/[^/?]+\/health(?:[/?]|$)/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Lange Zufallswerte im Pfad (Einladungs-, Helfer-, Bestaetigungslinks). */
const TOKEN_SEGMENT = /^[A-Za-z0-9_-]{32,}$/;

/**
 * Pfad fuer das Anfrage-Log: ohne Query-String und Fragment (dort stehen
 * Anmelde-, Abmelde- und Kopplungs-Tokens) und mit geschwaerzten
 * Token-Segmenten (`/invitations/<token>`, `/shifts/manage/<token>`).
 * UUIDs bleiben stehen — das sind IDs, keine Geheimnisse.
 */
export function requestLogPath(url: string | undefined): string {
  const path = stripQueryString(url ?? '');
  return path
    .split('/')
    .map((segment) =>
      TOKEN_SEGMENT.test(segment) && !UUID.test(segment) ? ':token' : segment,
    )
    .join('/');
}

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    /* Kein IP, kein User-Agent, keine Query: das Log braucht nur, was zum
       Nachvollziehen einer Anfrage reicht. Wo eine IP gebraucht wird
       (Sitzungen, Audit-Log), steht sie in der Datenbank. */
    const { method } = request;
    const url = requestLogPath(request.originalUrl || request.url);
    // Der Rumpf ist ungeprueftes JSON — nur fuers Debug-Log gelesen.
    const body = request.body as Record<string, unknown> | undefined;
    const requestId =
      (request.headers['x-request-id'] as string | undefined) ||
      this.generateRequestId();

    const now = Date.now();

    // Füge requestId zur Response hinzu
    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader('X-Request-Id', requestId);

    // Container-Health-Checks fragen alle paar Sekunden — die stehen nur
    // im Log, wenn sie fehlschlagen.
    const quiet = HEALTH_PATH.test(url);

    if (!quiet) {
      this.logger.log(`[${requestId}] ${method} ${url}`);
    }

    if (
      process.env.NODE_ENV === 'development' &&
      body &&
      Object.keys(body).length > 0
    ) {
      this.logger.debug(
        `[${requestId}] Body: ${JSON.stringify(body).substring(0, 500)}`,
      );
    }

    return next.handle().pipe(
      tap({
        next: () => {
          const statusCode = response.statusCode;
          if (quiet && statusCode < 400) return;
          const duration = Date.now() - now;
          this.logger.log(
            `[${requestId}] ${method} ${url} - ${statusCode} - ${duration}ms`,
          );
        },
        error: (error: { status?: number; message?: string }) => {
          const statusCode = error.status || 500;
          const duration = Date.now() - now;
          this.logger.error(
            `[${requestId}] ${method} ${url} - ${statusCode} - ${duration}ms - ${error.message}`,
          );
        },
      }),
    );
  }

  private generateRequestId(): string {
    return `req_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 9)}`;
  }
}
