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
 * Felder, die nie hinausgehen — egal an welchem Objekt sie haengen (Entity,
 * Relation, von Hand gebautes Objekt). Zugangsdaten, Pruefwerte und
 * Einmal-Codes: wer sie kennt, kann sich als Geraet, Bedienung oder
 * Benutzer ausgeben. Wer ein Konto betreibt, braucht seinen Passwort-Hash
 * nicht, und wer ein Geraet verwaltet, nicht dessen Zugangstoken.
 *
 * Die wenigen Antworten, die ein solches Feld einmalig liefern muessen
 * (Kopplung eines Geraets, neu vergebene PIN), geben es mit
 * `@RevealSecrets(...)` frei — siehe reveal-secrets.decorator.ts.
 *
 * Neue Spalten mit verdaechtigem Namen faellt `response-redaction.entities.spec.ts`
 * auf: sie muessen hier (oder in ENTITY_SECRET_FIELDS) eingetragen oder dort
 * ausdruecklich als unbedenklich gefuehrt werden.
 */
export const SECRET_FIELDS: ReadonlySet<string> = new Set([
  // Benutzer
  'passwordHash',
  'passwordResetToken',
  'passwordResetExpiresAt',
  'emailVerificationToken',
  'twoFactorSecretEncrypted',
  'twoFactorBackupCodesHash',
  'pendingEmailToken',
  // Pruefwerte gespeicherter Token und Codes (API-Token, Refresh-Token,
  // Anmelde-Links, Bedienungs-Sitzungen, Belege, E-Mail-Codes)
  'tokenHash',
  'codeHash',
  // Geraete: Zugangstoken und Kopplungscode
  'deviceToken',
  'verificationCode',
  // Pruefwert der Adresse, von der aus gekoppelt wurde
  'pairingIpHash',
  // PINs: Mitglieder (Altbestand), gemeinsamer PIN-Raum, Support
  'pin',
  'pinLookup',
  'supportPin',
  // Bestellsitzung (QR) und Bestaetigungslinks der Helferschichten
  'sessionToken',
  'verificationToken',
  // Verschluesselt abgelegte Geheimnisse (Webhooks, Cloud-TSE)
  'secretEncrypted',
  'previousSecretEncrypted',
  'accessTokenEnc',
]);

/**
 * Mehrdeutige Feldnamen, die nur an bestimmten Entities geheim sind:
 * `token` ist bei einer Einladung oder einem Helfer-Link der Schluessel
 * selbst, in anderen Antworten (neu angelegter API-Token, Bedienungs-
 * Sitzung) dagegen gerade das, was der Aufrufer bekommen soll.
 */
export const ENTITY_SECRET_FIELDS: Readonly<Record<string, readonly string[]>> =
  {
    Invitation: ['token'],
    HelperMagicLink: ['token'],
    ShiftChangeProposal: ['token'],
  };

function snakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * Rohe Abfrageergebnisse (`getRawMany`) tragen Spaltennamen statt
 * Eigenschaften: `device_device_token`, `u_password_hash`. Geschwaerzt
 * wird jeder Schluessel, der so heisst oder auf `_<spalte>` endet.
 */
const SECRET_COLUMN_NAMES: readonly string[] = [...SECRET_FIELDS].map(
  snakeCase,
);

function entitySecretFields(value: object): readonly string[] {
  const name = (value.constructor as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' && Object.hasOwn(ENTITY_SECRET_FIELDS, name)
    ? ENTITY_SECRET_FIELDS[name]
    : [];
}

function isSecretKey(key: string, reveal: ReadonlySet<string>): boolean {
  if (reveal.has(key)) return false;
  if (SECRET_FIELDS.has(key)) return true;
  for (const column of SECRET_COLUMN_NAMES) {
    if (key === column || key.endsWith(`_${column}`)) return true;
  }
  return false;
}

/**
 * Zahlungs-Zugangsdaten in den Organisationseinstellungen. Sie werden
 * maskiert statt entfernt: die Oberflaeche zeigt `****1234` an, damit man
 * sieht, dass ein Schluessel hinterlegt ist, und schickt diesen Wert beim
 * Speichern unveraendert zurueck — `OrganizationsService.update` setzt dann
 * den gespeicherten Schluessel wieder ein.
 */
export const MASKED_CREDENTIALS: Record<string, readonly string[]> = {
  sumup: ['apiKey', 'affiliateKey'],
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
export function redactResponse<T>(value: T, reveal: Iterable<string> = []): T {
  return walk(value, new WeakMap(), new Set(reveal)) as T;
}

function walk(
  value: unknown,
  seen: WeakMap<object, unknown>,
  reveal: ReadonlySet<string>,
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (isOpaque(value)) return value;

  // Zyklen (Relationen, die zurueckzeigen) nicht endlos verfolgen.
  const known = seen.get(value);
  if (known !== undefined) return known;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(walk(item, seen, reveal));
    return copy;
  }

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  const entitySecrets = entitySecretFields(value);
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretKey(key, reveal)) continue;
    if (entitySecrets.includes(key)) continue;

    const maskedKeys = MASKED_CREDENTIALS[key];
    if (maskedKeys && entry !== null && typeof entry === 'object') {
      const credentials = walk(entry, seen, reveal) as Record<string, unknown>;
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

    copy[key] = walk(entry, seen, reveal);
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
