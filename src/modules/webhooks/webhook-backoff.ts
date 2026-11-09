const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Abstand nach dem n-ten Fehlversuch (Index 0 = nach dem ersten). Acht
 * Versuche: sofort, +1 min, +5 min, +30 min, +2 h, +5 h, +8 h, +8 h —
 * zusammen gut 23½ Stunden.
 */
export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [
  1 * MINUTE,
  5 * MINUTE,
  30 * MINUTE,
  2 * HOUR,
  5 * HOUR,
  8 * HOUR,
  8 * HOUR,
];

/** ±10 %, damit nach einem Ausfall nicht alles im selben Moment ankommt. */
export const WEBHOOK_RETRY_JITTER = 0.1;

/**
 * Zeitpunkt des naechsten Versuchs nach `attempts` Versuchen, oder `null`,
 * wenn keiner mehr kommt. `random` liefert [0, 1) (Tests: fest).
 */
export function nextRetryAt(
  attempts: number,
  maxAttempts: number,
  now: Date,
  random: () => number = Math.random,
): Date | null {
  if (attempts >= maxAttempts) return null;
  const base =
    WEBHOOK_RETRY_DELAYS_MS[
      Math.min(attempts - 1, WEBHOOK_RETRY_DELAYS_MS.length - 1)
    ] ?? WEBHOOK_RETRY_DELAYS_MS[0];
  const factor = 1 + (random() * 2 - 1) * WEBHOOK_RETRY_JITTER;
  return new Date(now.getTime() + Math.round(base * factor));
}
