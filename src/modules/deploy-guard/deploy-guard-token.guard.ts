import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';
import type { Request } from 'express';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Bearer token for the deploy guard, compared against `DEPLOY_GUARD_TOKEN`.
 *
 * Without a configured token the endpoint does not exist (404) — a
 * self-hosted installation that does not use it exposes nothing. Hashing
 * both sides first makes the comparison constant-time regardless of length.
 */
@Injectable()
export class DeployGuardTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('DEPLOY_GUARD_TOKEN');
    if (!expected) {
      throw new NotFoundException();
    }

    const header = context
      .switchToHttp()
      .getRequest<Request>()
      .headers.authorization?.trim();
    const presented = header?.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : '';

    if (!presented || !timingSafeEqual(digest(presented), digest(expected))) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
