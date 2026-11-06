import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Abmeldelink fuer kuenftige Newsletter-Mails (Datenschutzerklaerung 13.3):
 * `<userId>.<Signatur>`, HMAC-SHA256 mit einem aus `JWT_SECRET`
 * abgeleiteten Schluessel. Ohne Ablauf, damit der Link in jeder alten Mail
 * funktioniert; er kann nur abmelden, nie anmelden.
 */
const PURPOSE = 'openeos:newsletter-unsubscribe:v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function signature(userId: string, secret: string): Buffer {
  return createHmac('sha256', `${PURPOSE}:${secret}`)
    .update(userId.toLowerCase())
    .digest();
}

export function newsletterUnsubscribeToken(
  userId: string,
  secret: string,
): string {
  return `${userId.toLowerCase()}.${signature(userId, secret).toString('base64url')}`;
}

/** Benutzer-ID aus einem gueltigen Token, sonst `null`. */
export function verifyNewsletterUnsubscribeToken(
  token: unknown,
  secret: string,
): string | null {
  // Query-Parameter koennen als Liste ankommen (?token=a&token=b).
  if (typeof token !== 'string' || !token || token.length > 200 || !secret) {
    return null;
  }
  const [userId, sig, extra] = token.trim().split('.');
  if (!userId || !sig || extra !== undefined || !UUID.test(userId)) {
    return null;
  }
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  const expected = signature(userId, secret);
  if (given.length !== expected.length) return null;
  return timingSafeEqual(given, expected) ? userId.toLowerCase() : null;
}

/** Link fuer Mails und den `List-Unsubscribe`-Kopf. */
export function newsletterUnsubscribeUrl(
  appUrl: string,
  userId: string,
  secret: string,
): string {
  const token = encodeURIComponent(newsletterUnsubscribeToken(userId, secret));
  return `${appUrl.replace(/\/+$/, '')}/newsletter/abmelden?token=${token}`;
}

/** Angemeldet ist, wer eine Einwilligung ohne spaeteren Widerruf hat. */
export function isNewsletterSubscribed(user: {
  newsletterOptInAt: Date | null;
  newsletterOptOutAt: Date | null;
}): boolean {
  if (!user.newsletterOptInAt) return false;
  if (!user.newsletterOptOutAt) return true;
  return (
    new Date(user.newsletterOptOutAt).getTime() <
    new Date(user.newsletterOptInAt).getTime()
  );
}
