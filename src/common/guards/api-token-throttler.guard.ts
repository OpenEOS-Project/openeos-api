import { ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';

import { ErrorCodes, ErrorReasons } from '../constants/error-codes';
import type { AppRequest } from '../types/request.types';

/** Grenzen je Token (ki-plan.md Abschnitt 2.5): 120 Aufrufe je Minute, 5.000 je Tag. */
export const API_TOKEN_LIMITS = [
  { name: 'api-token-minute', limit: 120, ttl: 60 * 1000 },
  { name: 'api-token-day', limit: 5000, ttl: 24 * 60 * 60 * 1000 },
] as const;

/**
 * Rate-Limit je API-Token.
 *
 * Laeuft nach dem JwtAuthGuard (der setzt `request.apiToken`) und nur fuer
 * Anfragen mit API-Token; alles andere faellt weiter unter die IP-Grenze
 * des globalen ThrottlerGuard. Zaehlt pro Token, nicht pro Adresse: ein
 * Agent hinter wechselnden IPs bleibt derselbe Agent, und zwei Tokens
 * hinter derselben IP behindern sich nicht.
 *
 * Nutzt den Speicher des Throttler-Moduls — Zaehler sind je Instanz.
 */
@Injectable()
export class ApiTokenThrottlerGuard extends ThrottlerGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<AppRequest>();
    if (!request.apiToken) return true;

    for (const grenze of API_TOKEN_LIMITS) {
      await this.handleRequest({
        context,
        limit: grenze.limit,
        ttl: grenze.ttl,
        blockDuration: 0,
        throttler: { name: grenze.name, limit: grenze.limit, ttl: grenze.ttl },
        getTracker: (req) => this.getTracker(req),
        generateKey: (ctx, tracker, name) =>
          this.generateKey(ctx, tracker, name),
      });
    }
    return true;
  }

  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const token = (req as unknown as AppRequest).apiToken;
    return Promise.resolve(token ? `api-token:${token.id}` : 'api-token:none');
  }

  protected generateKey(
    _context: ExecutionContext,
    tracker: string,
    name: string,
  ): string {
    return `${name}:${tracker}`;
  }

  protected throwThrottlingException(
    _context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const minute = detail.ttl <= 60 * 1000;
    throw new HttpException(
      {
        code: ErrorCodes.RATE_LIMITED,
        reason: ErrorReasons.API_TOKEN_RATE_LIMITED,
        message: minute
          ? `Höchstens ${detail.limit} Aufrufe je Minute mit diesem API-Token`
          : `Höchstens ${detail.limit} Aufrufe je Tag mit diesem API-Token`,
        params: {
          limit: detail.limit,
          window: minute ? 'minute' : 'day',
          retryAfterSeconds: detail.timeToBlockExpire,
        },
      },
      429,
    );
  }
}
