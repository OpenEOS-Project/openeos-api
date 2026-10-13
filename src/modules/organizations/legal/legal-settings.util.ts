import { BadRequestException } from '@nestjs/common';

import {
  ErrorCodes,
  ErrorReasons,
} from '../../../common/constants/error-codes';
import type {
  Organization,
  OrganizationLegalSettings,
} from '../../../database/entities/organization.entity';

/** Laengen der rechtlichen Angaben. Die Oberflaeche zeigt dieselben Grenzen. */
export const LEGAL_LIMITS = {
  url: 500,
  imprintText: 5000,
  privacyText: 20000,
  contactEmail: 255,
} as const;

type LegalField = keyof OrganizationLegalSettings;

const URL_FIELDS = ['imprintUrl', 'privacyUrl'] as const;
const TEXT_FIELDS = ['imprintText', 'privacyText'] as const;

/** Fehlerart je Feld; die Oberflaeche uebersetzt danach. */
type LegalErrorCode =
  | 'type'
  | 'unknownField'
  | 'url'
  | 'maxLength'
  | 'linkOrText'
  | 'email';

function invalid(
  field: LegalField | 'legal',
  code: LegalErrorCode,
  message: string,
): never {
  throw new BadRequestException({
    code: ErrorCodes.VALIDATION_ERROR,
    reason: ErrorReasons.ORGANIZATION_LEGAL_INVALID,
    message,
    details: [
      { field: field === 'legal' ? 'legal' : `legal.${field}`, code, message },
    ],
  });
}

/** Leere Eingaben gelten als "nicht gesetzt" — so loescht die Oberflaeche. */
function readString(
  input: Record<string, unknown>,
  field: LegalField,
): string | undefined {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    invalid(field, 'type', `${field} muss ein Text sein.`);
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Nur absolute http(s)-Links. Alles andere (javascript:, data:, relative
 * Pfade) landete sonst als href auf einer oeffentlichen Seite.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * Freitext vereinheitlichen: Zeilenenden auf \n, Steuerzeichen ausser
 * Zeilenumbruch und Tabulator entfernen. Formatiert wird erst beim Anzeigen
 * (Absaetze, Zeilenumbrueche, einfache Ueberschriften und Links) — gespeichert
 * wird reiner Text, kein HTML.
 */
function cleanText(value: string): string {
  return (
    value
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim()
  );
}

/**
 * Prueft und bereinigt `settings.legal`, bevor es gespeichert wird.
 *
 * Nicht gesetzte Felder fehlen im Ergebnis; ist nichts gesetzt, kommt ein
 * leeres Objekt zurueck. Fehler sind BadRequest mit `details[].field`
 * (z. B. `legal.imprintUrl`), damit die Oberflaeche sie dem Feld zuordnen kann.
 */
export function normalizeLegalSettings(
  input: unknown,
): OrganizationLegalSettings {
  if (input === null || input === undefined) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    invalid('legal', 'type', 'Rechtliche Angaben müssen ein Objekt sein.');
  }
  const raw = input as Record<string, unknown>;

  const allowed: LegalField[] = [...URL_FIELDS, ...TEXT_FIELDS, 'contactEmail'];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key as LegalField)) {
      invalid(
        'legal',
        'unknownField',
        `Unbekanntes Feld in den rechtlichen Angaben: ${key}`,
      );
    }
  }

  const result: OrganizationLegalSettings = {};

  for (const field of URL_FIELDS) {
    const value = readString(raw, field);
    if (value === undefined) continue;
    if (value.length > LEGAL_LIMITS.url) {
      invalid(
        field,
        'maxLength',
        `Der Link darf höchstens ${LEGAL_LIMITS.url} Zeichen lang sein.`,
      );
    }
    if (!isHttpUrl(value)) {
      invalid(
        field,
        'url',
        'Bitte gib einen vollständigen Link an, der mit https:// oder http:// beginnt.',
      );
    }
    result[field] = value;
  }

  for (const field of TEXT_FIELDS) {
    const value = readString(raw, field);
    if (value === undefined) continue;
    const text = cleanText(value);
    const max = LEGAL_LIMITS[field];
    if (text.length > max) {
      invalid(
        field,
        'maxLength',
        `Der Text darf höchstens ${max} Zeichen lang sein.`,
      );
    }
    if (text) result[field] = text;
  }

  if (result.imprintUrl && result.imprintText) {
    invalid(
      'imprintText',
      'linkOrText',
      'Für das Impressum bitte entweder einen Link oder einen Text angeben, nicht beides.',
    );
  }
  if (result.privacyUrl && result.privacyText) {
    invalid(
      'privacyText',
      'linkOrText',
      'Für den Datenschutzhinweis bitte entweder einen Link oder einen Text angeben, nicht beides.',
    );
  }

  const email = readString(raw, 'contactEmail');
  if (email !== undefined) {
    if (
      email.length > LEGAL_LIMITS.contactEmail ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      invalid(
        'contactEmail',
        'email',
        'Bitte gib eine gültige E-Mail-Adresse an.',
      );
    }
    result.contactEmail = email;
  }

  return result;
}

/** Links von OpenEOS als Plattformbetreiber; leer heisst "nicht anzeigen". */
export interface PlatformLegalLinks {
  imprintUrl: string | null;
  privacyUrl: string | null;
}

/** Was oeffentliche Seiten ueber Impressum und Datenschutz erfahren. */
export interface PublicLegalInfo {
  /** Name des Vereins als Verantwortlicher. */
  organizationName: string;
  imprintUrl: string | null;
  imprintText: string | null;
  privacyUrl: string | null;
  privacyText: string | null;
  contactEmail: string | null;
  /** Hat der Verein Impressum und Datenschutzhinweis hinterlegt? */
  complete: boolean;
  platform: PlatformLegalLinks;
}

/**
 * Die oeffentliche Sicht auf `settings.legal` — bewusst nur diese Felder,
 * nichts sonst aus den Einstellungen (dort stehen auch Zugangsdaten).
 *
 * Bestandsdaten werden nicht noch einmal geprueft; ein Link, der kein
 * http(s) ist, wird aber nie ausgeliefert.
 */
export function toPublicLegalInfo(
  organization: Pick<Organization, 'name' | 'settings'> | null | undefined,
  platform: PlatformLegalLinks,
): PublicLegalInfo {
  const legal: OrganizationLegalSettings = organization?.settings?.legal ?? {};
  const url = (value: string | undefined) =>
    value && isHttpUrl(value) ? value : null;
  const text = (value: string | undefined) =>
    typeof value === 'string' && value.trim() ? value : null;

  const imprintUrl = url(legal.imprintUrl);
  const imprintText = imprintUrl ? null : text(legal.imprintText);
  const privacyUrl = url(legal.privacyUrl);
  const privacyText = privacyUrl ? null : text(legal.privacyText);

  return {
    organizationName: organization?.name ?? '',
    imprintUrl,
    imprintText,
    privacyUrl,
    privacyText,
    contactEmail: text(legal.contactEmail),
    complete:
      Boolean(imprintUrl || imprintText) && Boolean(privacyUrl || privacyText),
    platform: {
      imprintUrl: platform.imprintUrl || null,
      privacyUrl: platform.privacyUrl || null,
    },
  };
}
