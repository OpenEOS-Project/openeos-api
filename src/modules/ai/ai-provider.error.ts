/**
 * Woran ein Modellaufruf gescheitert ist — grob genug, dass der Aufrufer
 * daraus eine verstaendliche Meldung machen kann, ohne den Text zu lesen:
 *
 * - `auth`: Schluessel fehlt oder wurde abgelehnt (401/403)
 * - `rate_limit`: 429 oder ueberlastet (529)
 * - `unavailable`: keine Antwort — Netzwerk, Timeout, 5xx
 * - `invalid_output`: Antwort passt nicht zum Schema, abgelehnt, abgeschnitten
 * - `other`: alles andere
 */
export type AiProviderErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'unavailable'
  | 'invalid_output'
  | 'other';

/**
 * Der Anbieter hat nicht geantwortet, abgelehnt oder etwas geliefert, das
 * nicht zum Schema passt. Traegt keine Nutzdaten — der Text landet nur im
 * Log und in `menu_imports.error_detail`, nie beim Nutzer.
 */
export class AiProviderError extends Error {
  readonly kind: AiProviderErrorKind;

  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
    kind?: AiProviderErrorKind,
  ) {
    super(message);
    this.name = 'AiProviderError';
    this.kind = kind ?? AiProviderError.kindOf(status, retryable);
  }

  private static kindOf(
    status: number | undefined,
    retryable: boolean,
  ): AiProviderErrorKind {
    if (status === 401 || status === 403) return 'auth';
    if (status === 429 || status === 529) return 'rate_limit';
    if (status === 408 || status === 504) return 'unavailable';
    if (retryable) return 'unavailable';
    return 'other';
  }
}
