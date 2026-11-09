import { createHash, createHmac, randomBytes, randomInt } from 'crypto';

/** PINs an der Kasse: 4 bis 6 Ziffern (Mitglieder und Bedienungen). */
export const PIN_PATTERN = /^\d{4,6}$/;
export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 6;

/**
 * Pepper fuer die PIN-Pruefwerte.
 *
 * - `PIN_PEPPER` gesetzt: der wird genommen (empfohlen, min. 32 Zeichen,
 *   nicht in der Datenbank, nicht im Backup der Datenbank).
 * - Sonst abgeleitet aus `TWO_FACTOR_ENCRYPTION_KEY` (in Produktion
 *   Pflicht): HMAC(key, "openeos-pin-pepper-v1"). Damit startet ein Server
 *   ohne neue Variable weiter; der Start meldet das laut im Log.
 * - Ohne beides (Entwicklung, Tests): fester Entwicklungswert.
 *
 * Wer den Pepper spaeter wechselt (auch: PIN_PEPPER nachtraeglich setzen
 * oder TWO_FACTOR_ENCRYPTION_KEY tauschen, solange PIN_PEPPER fehlt),
 * macht alle gespeicherten PINs ungueltig; `pepperId` an jedem Eintrag
 * macht das sichtbar (PIN neu vergeben).
 */
export interface PepperSource {
  pinPepper?: string | null;
  fallbackSecret?: string | null;
}

export type PepperOrigin = 'env' | 'derived' | 'development';

export function resolvePepper(source: PepperSource): {
  pepper: Buffer;
  origin: PepperOrigin;
} {
  const own = source.pinPepper?.trim();
  if (own) return { pepper: Buffer.from(own, 'utf8'), origin: 'env' };
  const fallback = source.fallbackSecret?.trim();
  if (fallback) {
    return {
      pepper: createHmac('sha256', fallback)
        .update('openeos-pin-pepper-v1')
        .digest(),
      origin: 'derived',
    };
  }
  return {
    pepper: Buffer.from('openeos-development-pin-pepper', 'utf8'),
    origin: 'development',
  };
}

/** Kurzer, nicht umkehrbarer Fingerabdruck des Peppers (8 Hex-Zeichen). */
export function pepperFingerprint(pepper: Buffer): string {
  return createHmac('sha256', pepper)
    .update('openeos-pin-pepper-id')
    .digest('hex')
    .slice(0, 8);
}

/** HMAC-SHA256(pepper, "<orgId>:<pin>") als Hex (64 Zeichen). */
export function pinLookup(
  pepper: Buffer,
  organizationId: string,
  pin: string,
): string {
  return createHmac('sha256', pepper)
    .update(`${organizationId.toLowerCase()}:${pin}`)
    .digest('hex');
}

/** Haeufige PINs, die trotz unauffaelligem Muster ausgeschlossen sind. */
const COMMON_PINS = new Set([
  '1122',
  '1100',
  '2580',
  '0852',
  '6969',
  '1004',
  '2000',
  '1313',
  '2468',
  '1357',
  '0007',
  '1001',
  '4711',
  '112233',
  '654321',
  '159753',
  '147258',
  '696969',
  '101010',
]);

/**
 * Zu einfache PINs: gleiche Ziffern, auf- oder absteigende Folgen (auch
 * ueber 9→0 hinweg), Wiederholungen eines Musters (1212, 123123) und eine
 * kurze Liste haeufiger PINs. Vergabe und eigene Wahl lehnen sie ab
 * (einheitlich PIN_NOT_AVAILABLE).
 */
export function isTrivialPin(pin: string): boolean {
  if (!PIN_PATTERN.test(pin)) return true;
  if (COMMON_PINS.has(pin)) return true;
  const digits = [...pin].map(Number);
  const steps = digits.slice(1).map((d, i) => (d - digits[i] + 10) % 10);
  if (steps.every((s) => s === 0)) return true; // 0000
  if (steps.every((s) => s === 1)) return true; // 1234, 7890
  if (steps.every((s) => s === 9)) return true; // 4321, 1098
  for (const size of [1, 2, 3]) {
    if (pin.length % size !== 0 || pin.length === size) continue;
    const unit = pin.slice(0, size);
    if (unit.repeat(pin.length / size) === pin) return true; // 1212, 123123
  }
  return false;
}

/** Zufaellige PIN (CSPRNG) der Laenge `length`, nie trivial. */
export function generatePin(length: number): string {
  for (;;) {
    let pin = '';
    for (let i = 0; i < length; i += 1) pin += String(randomInt(0, 10));
    if (!isTrivialPin(pin)) return pin;
  }
}

/** Sitzungs-Token: 32 Byte Zufall (base64url); gespeichert wird nur der Hash. */
export function newSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashSessionToken(token) };
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
