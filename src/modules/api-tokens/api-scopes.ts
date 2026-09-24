/**
 * Was ein API-Token dürfen kann.
 *
 * Von Anfang an vorhanden, obwohl es zunächst nur einen gibt:
 * Geltungsbereiche nachträglich einzuziehen heißt, bestehende Tokens
 * entweder zu entwerten oder pauschal alles zu erlauben — beides will
 * später niemand entscheiden müssen.
 */
export const API_SCOPES = {
  /** Kennzahlen lesen: Anzahl Nutzer, Organisationen, Umsätze. */
  MONITORING_READ: 'monitoring:read',
} as const;

export type ApiScope = (typeof API_SCOPES)[keyof typeof API_SCOPES];

export const ALLE_SCOPES: ApiScope[] = Object.values(API_SCOPES);
