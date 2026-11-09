import * as crypto from 'crypto';

export const WEBHOOK_SECRET_PREFIX = 'whsec_';

/** `whsec_` + 32 Zufallsbytes (base64url, 43 Zeichen). */
export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
}

/** Erkennungszeichen fuer die Liste: `whsec_3fA9…`. */
export function webhookSecretHint(secret: string): string {
  return `${secret.slice(0, 10)}…`;
}

/** hex(HMAC-SHA256(secret, `${t}.${body}`)) — das ganze Geheimnis samt Praefix ist der Schluessel. */
export function computeWebhookSignature(
  secret: string,
  timestamp: number,
  body: string,
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`, 'utf8')
    .digest('hex');
}

/**
 * Kopfzeile `OpenEOS-Signature` im Stil von Stripe: `t=<Sekunden>,v1=<hex>`;
 * waehrend der Uebergangszeit nach dem Erneuern folgt ein zweites `v1=` mit
 * dem alten Geheimnis.
 */
export function buildSignatureHeader(
  secrets: string[],
  timestamp: number,
  body: string,
): string {
  return [
    `t=${timestamp}`,
    ...secrets.map((s) => `v1=${computeWebhookSignature(s, timestamp, body)}`),
  ].join(',');
}

export type SignatureCheck =
  | { valid: true }
  | { valid: false; reason: 'malformed' | 'expired' | 'mismatch' };

/**
 * Pruefung wie beim Empfaenger (Doku, Tests): Zeitstempel hoechstens
 * `toleranceSeconds` alt bzw. in der Zukunft, irgendein `v1` passt, Vergleich
 * in konstanter Zeit.
 */
export function verifyWebhookSignature(
  secret: string,
  header: string,
  body: string,
  options: { toleranceSeconds?: number; now?: number } = {},
): SignatureCheck {
  const tolerance = options.toleranceSeconds ?? 300;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2).map((s) => s?.trim());
    if (key === 't' && value && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === 'v1' && value && /^[0-9a-f]{64}$/.test(value)) {
      signatures.push(value);
    }
  }
  if (timestamp === null || signatures.length === 0) {
    return { valid: false, reason: 'malformed' };
  }
  if (Math.abs(now - timestamp) > tolerance) {
    return { valid: false, reason: 'expired' };
  }
  const expected = Buffer.from(
    computeWebhookSignature(secret, timestamp, body),
    'hex',
  );
  const ok = signatures.some((candidate) =>
    crypto.timingSafeEqual(expected, Buffer.from(candidate, 'hex')),
  );
  return ok ? { valid: true } : { valid: false, reason: 'mismatch' };
}
