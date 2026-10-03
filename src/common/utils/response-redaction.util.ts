import { StreamableFile } from '@nestjs/common';

/**
 * Schwaerzt Geheimnisse in allem, was die API verlaesst.
 *
 * Das Projekt hat keinen Serializer: ein zurueckgegebenes Entity-Objekt
 * veroeffentlicht jede Spalte, und jede geladene Relation gleich mit. Das
 * war bisher an einzelnen Stellen von Hand abgefangen — und an anderen
 * nicht. Ein einfaches Mitglied bekam so ueber `GET /organizations/:id`
 * (Relation `userOrganizations.user`) die Passwort-Hashes, Reset-Tokens und
 * 2FA-Geheimnisse aller Mitglieder, und ueber `/auth/me`, die
 * Organisationsliste und die Geraete-API die Zahlungsschluessel der
 * Organisation im Klartext.
 *
 * Deshalb hier eine Stelle, die jede Antwort durchlaeuft, statt vieler
 * Stellen, von denen die naechste neue wieder vergessen wird. Die Regeln
 * haengen am Feldnamen, nicht am Endpunkt: ein Feld dieses Namens hat in
 * keiner Antwort etwas zu suchen, egal wie es dorthin gekommen ist.
 */

/**
 * Felder am Benutzer, die nie hinausgehen — auch nicht an den Benutzer
 * selbst. Wer ein Konto betreibt, braucht seinen Passwort-Hash nicht.
 */
const USER_SECRET_FIELDS = new Set([
  'passwordHash',
  'passwordResetToken',
  'passwordResetExpiresAt',
  'emailVerificationToken',
  'twoFactorSecretEncrypted',
  'twoFactorBackupCodesHash',
  'pendingEmailToken',
  'tokenHash',
]);

/**
 * Zahlungs-Zugangsdaten in den Organisationseinstellungen. Sie werden
 * maskiert statt entfernt: die Oberflaeche zeigt `****1234` an, damit man
 * sieht, dass ein Schluessel hinterlegt ist, und schickt diesen Wert beim
 * Speichern unveraendert zurueck — `OrganizationsService.update` setzt dann
 * den gespeicherten Schluessel wieder ein.
 */
export const MASKED_CREDENTIALS: Record<string, readonly string[]> = {
  sumup: ['apiKey', 'affiliateKey'],
  paypal: ['clientSecret'],
};

export const MASK_PREFIX = '****';

export function maskSecret(value: string): string {
  return `${MASK_PREFIX}${value.slice(-4)}`;
}

export function isMaskedSecret(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(MASK_PREFIX);
}

function isOpaque(value: object): boolean {
  return (
    value instanceof Date ||
    value instanceof StreamableFile ||
    Buffer.isBuffer(value) ||
    typeof (value as { pipe?: unknown }).pipe === 'function'
  );
}

/**
 * Liefert eine geschwaerzte Kopie. Das Original bleibt unberuehrt — es kann
 * ein Entity-Objekt sein, das im Prozess noch weiterverwendet wird, und
 * genau eine solche Mutation hatte zuvor maskierte Werte in die Datenbank
 * geschrieben.
 */
export function redactResponse<T>(value: T): T {
  return walk(value, new WeakMap()) as T;
}

function walk(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (isOpaque(value)) return value;

  // Zyklen (Relationen, die zurueckzeigen) nicht endlos verfolgen.
  const known = seen.get(value);
  if (known !== undefined) return known;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(walk(item, seen));
    return copy;
  }

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, entry] of Object.entries(value)) {
    if (USER_SECRET_FIELDS.has(key)) continue;

    const maskedKeys = MASKED_CREDENTIALS[key];
    if (maskedKeys && entry !== null && typeof entry === 'object') {
      const credentials = walk(entry, seen) as Record<string, unknown>;
      const masked: Record<string, unknown> = { ...credentials };
      for (const field of maskedKeys) {
        const secret = masked[field];
        if (typeof secret === 'string' && secret.length > 0) {
          masked[field] = maskSecret(secret);
        }
      }
      copy[key] = masked;
      continue;
    }

    copy[key] = walk(entry, seen);
  }
  return copy;
}

/**
 * Setzt maskierte Zugangsdaten in eingehenden Einstellungen auf den
 * gespeicherten Wert zurueck.
 *
 * Kommt `****1234` herein, hat der Benutzer den Schluessel nicht angefasst:
 * er bekam ihn maskiert angezeigt und hat ihn so zurueckgeschickt. Ist kein
 * Wert gespeichert, faellt das Feld weg, statt die Maske zu speichern.
 *
 * Aendert `incoming` an Ort und Stelle; `stored` wird nur gelesen.
 */
export function restoreMaskedCredentials(
  incoming: Record<string, unknown> | undefined,
  stored: Record<string, unknown> | undefined,
): void {
  if (!incoming) return;

  for (const [section, fields] of Object.entries(MASKED_CREDENTIALS)) {
    const incomingSection = incoming[section];
    if (!incomingSection || typeof incomingSection !== 'object') continue;

    const target = incomingSection as Record<string, unknown>;
    const storedSection = stored?.[section] as
      | Record<string, unknown>
      | undefined;

    for (const field of fields) {
      if (!isMaskedSecret(target[field])) continue;
      const original = storedSection?.[field];
      if (typeof original === 'string' && original.length > 0) {
        target[field] = original;
      } else {
        delete target[field];
      }
    }
  }
}
