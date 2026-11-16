/**
 * Arten von Anmeldetoken (JWT), unterschieden am Claim `typ`.
 *
 * - `access`: voller Zugang nach abgeschlossener Anmeldung.
 * - `2fa_pending`: Ausweis zwischen erstem und zweitem Anmeldeschritt;
 *   oeffnet nur die Endpunkte des zweiten Schritts.
 *
 * Eine Datei fuer alle Stellen, die Token pruefen (HTTP-Guard, WebSocket),
 * damit sie dieselbe Regel anwenden.
 */
export const ACCESS_TOKEN_TYPE = 'access';
export const TWO_FACTOR_PENDING_TOKEN_TYPE = '2fa_pending';

export type TokenType =
  | typeof ACCESS_TOKEN_TYPE
  | typeof TWO_FACTOR_PENDING_TOKEN_TYPE;

/** Die Claims, auf die es fuer die Einordnung ankommt. */
export interface TokenTypeClaims {
  typ?: unknown;
  pending2fa?: unknown;
  sid?: unknown;
  sub?: unknown;
}

/** Ausweis fuer den zweiten Anmeldeschritt? */
export function isTwoFactorPendingToken(
  payload: TokenTypeClaims | null | undefined,
): boolean {
  if (!payload) return false;
  return (
    payload.typ === TWO_FACTOR_PENDING_TOKEN_TYPE || payload.pending2fa === true
  );
}

/**
 * Voller Zugangstoken?
 *
 * Verlangt `typ: 'access'`. Token, die vor Einfuehrung des Claims
 * ausgegeben wurden, tragen ihn noch nicht; sie gelten nur, wenn sie zu
 * einer Sitzung gehoeren (`sid`) — das hatten Ausweise fuer den zweiten
 * Schritt nie. Diese Ausnahme betrifft nur noch nicht abgelaufene
 * Zugangstoken (Laufzeit Minuten) und kann spaeter entfallen.
 */
export function isFullAccessToken(
  payload: TokenTypeClaims | null | undefined,
): boolean {
  if (!payload || typeof payload.sub !== 'string' || !payload.sub) {
    return false;
  }
  if (isTwoFactorPendingToken(payload)) return false;
  if (payload.typ === ACCESS_TOKEN_TYPE) return true;
  return (
    payload.typ === undefined &&
    typeof payload.sid === 'string' &&
    payload.sid.length > 0
  );
}
