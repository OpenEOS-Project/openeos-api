/**
 * Does this verified JWT payload stand for a completed sign-in?
 *
 * The token from the first sign-in step (password accepted, second factor
 * still missing) carries `pending2fa: true` and is only meant for the
 * two-factor endpoints. Should a token ever carry an explicit type claim,
 * only an access token counts.
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
  const claims = payload as Record<string, unknown>;
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) return false;
  if (claims.pending2fa === true) return false;
  for (const key of ['typ', 'type', 'tokenType']) {
    const value = claims[key];
    if (value !== undefined && value !== 'access') return false;
  }
  return true;
}
