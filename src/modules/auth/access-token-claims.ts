import { isFullAccessToken } from './token-types';

/**
 * Does this verified JWT payload stand for a completed sign-in?
 *
 * Same rule as the HTTP guard (`JwtStrategy`, see token-types.ts): an
 * access token (`typ: 'access'`, or a session token issued before the
 * claim existed); never the token of the first sign-in step.
 *
 * Shared by every place that accepts a JWT outside the HTTP guard chain
 * (e.g. the realtime gateway), so they cannot drift apart.
 */
export function isFullSessionToken(payload: unknown): payload is {
  sub: string;
  email?: string;
  exp?: number;
} {
  if (!payload || typeof payload !== 'object') return false;
  return isFullAccessToken(payload as Record<string, unknown>);
}
