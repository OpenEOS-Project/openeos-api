/** Standard von THROTTLE_LIMIT (Anfragen je Minute und Adresse). */
const DEFAULT_GLOBAL_LIMIT = 300;

/**
 * Schranke fuer ein einzelnes Endpunkt-Limit (`@Throttle`), die mit dem
 * allgemeinen THROTTLE_LIMIT mitwaechst: Wer das allgemeine Limit anhebt
 * (z. B. Testumgebungen, in denen alle Anfragen von einer Adresse kommen),
 * hebt die strengeren Endpunkt-Limits im selben Verhaeltnis an. Mit dem
 * Standard oder einem kleineren Wert gilt `base` unveraendert.
 */
export function scaledLimit(base: number): () => number {
  return () => {
    const configured = Number(process.env.THROTTLE_LIMIT);
    const factor =
      Number.isFinite(configured) && configured > DEFAULT_GLOBAL_LIMIT
        ? configured / DEFAULT_GLOBAL_LIMIT
        : 1;
    return Math.ceil(base * factor);
  };
}
