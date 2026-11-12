import { createHash, randomInt, timingSafeEqual } from 'crypto';

/** Ohne leicht verwechselbare Zeichen (0/O, 1/I/L), gut abzutippen. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Einrichtungscode wie `K7QM-2XRT-9HCP` (60 Bit). */
export function generateSetupToken(): string {
  const groups: string[] = [];
  for (let g = 0; g < 3; g++) {
    let group = '';
    for (let i = 0; i < 4; i++) group += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(group);
  }
  return groups.join('-');
}

/** Gross/klein, Leerzeichen und Bindestriche spielen keine Rolle. */
export function normalizeSetupToken(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase();
}

export function setupTokenMatches(
  given: string | null | undefined,
  expected: string,
): boolean {
  if (!given) return false;
  const a = createHash('sha256').update(normalizeSetupToken(given)).digest();
  const b = createHash('sha256').update(normalizeSetupToken(expected)).digest();
  return timingSafeEqual(a, b);
}
