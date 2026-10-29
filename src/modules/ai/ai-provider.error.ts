/**
 * Der Anbieter hat nicht geantwortet, abgelehnt oder etwas geliefert, das
 * nicht zum Schema passt. Traegt keine Nutzdaten — der Text landet im Log
 * und im `error` eines Imports.
 */
export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}
