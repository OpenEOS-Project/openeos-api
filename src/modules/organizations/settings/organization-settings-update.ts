import { BadRequestException } from '@nestjs/common';

import {
  ErrorCodes,
  ErrorReasons,
} from '../../../common/constants/error-codes';

/**
 * Welche Abschnitte von `organizations.settings` sich ueber
 * `PATCH /organizations/:id` aendern lassen.
 *
 * Alles andere hat einen eigenen Endpunkt mit eigenen Pruefungen und
 * eigenem Protokoll (Assistent, Integrationen samt Cloud-TSE, Betriebsart,
 * Steuerstatus-Verlauf, DSFinV-K, Aufbewahrung, Abrechnung) oder wird nur
 * vom Server geschrieben (PIN-Sperre der Bedienungen). Die Oberflaeche
 * schickt an manchen Stellen die kompletten Einstellungen zurueck — solche
 * unveraenderten Abschnitte werden still uebergangen, eine Aenderung daran
 * lehnt die API ab.
 */

type Check = (value: unknown) => string | null;

const MAX_SECTION_JSON = 32_000;

const string =
  (max: number): Check =>
  (value) =>
    value === null || (typeof value === 'string' && value.length <= max)
      ? null
      : `string (max. ${max})`;

const boolean: Check = (value) =>
  typeof value === 'boolean' ? null : 'boolean';

const section: Check = (value) => {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'object';
  if (JSON.stringify(value).length > MAX_SECTION_JSON) return 'too large';
  return null;
};

const currency: Check = (value) =>
  typeof value === 'string' && /^[A-Z]{3}$/.test(value)
    ? null
    : 'ISO 4217 code';

const timezone: Check = (value) => {
  if (typeof value !== 'string' || value.length > 64) return 'time zone';
  try {
    new Intl.DateTimeFormat('de-DE', { timeZone: value });
    return null;
  } catch {
    return 'time zone';
  }
};

const locale: Check = (value) =>
  typeof value === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(value)
    ? null
    : 'locale';

/** Aenderbar ueber PATCH /organizations/:id, mit grober Formpruefung. */
export const UPDATABLE_ORGANIZATION_SETTINGS: Readonly<Record<string, Check>> =
  {
    currency,
    timezone,
    locale,
    description: string(2000),
    taxId: string(100),
    legalName: string(200),
    taxNumber: string(100),
    vatId: string(100),
    vatExempt: boolean,
    address: section,
    contact: section,
    receipt: section,
    legal: section,
    pos: section,
    pfand: section,
    onlineOrdering: section,
    orderFlow: section,
    sumup: section,
    paypal: section,
    waiters: section,
    eventReminders: section,
  };

/**
 * Abschnitte mit eigenem Endpunkt bzw. nur vom Server geschrieben. Nur zur
 * Dokumentation und fuer Tests — abgelehnt wird jede Aenderung an einem
 * Schluessel, der nicht in UPDATABLE_ORGANIZATION_SETTINGS steht.
 */
export const DEDICATED_ORGANIZATION_SETTINGS = [
  'assistant', // /organizations/:id/assistant
  'integrations', // PATCH /organizations/:id/integrations/:integrationId
  'operatingMode', // PATCH /organizations/:id/operating-mode
  'operatingModeSince',
  'payments',
  'vatStatusHistory', // POST /organizations/:id/vat-status
  'dsfinvk',
  'retention',
  'billing',
  'tse',
  'waiterPinLockedAt',
] as const;

/** Reihenfolge der Schluessel egal, sonst strukturell gleich. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function sameValue(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

/**
 * Bereinigt `settings` aus dem PATCH-Body: unveraenderte Abschnitte fallen
 * weg, nicht aenderbare oder unbekannte Abschnitte mit neuem Wert und
 * ungueltige Werte enden in 400. Veraendert `incoming` an Ort und Stelle
 * und gibt es zurueck.
 */
export function filterOrganizationSettingsUpdate<
  T extends Record<string, unknown> | null | undefined,
>(incoming: T, stored: Record<string, unknown> | null | undefined): T {
  if (!incoming) return incoming;
  const current = stored ?? {};
  for (const key of Object.keys(incoming)) {
    const value = incoming[key];
    const check = Object.prototype.hasOwnProperty.call(
      UPDATABLE_ORGANIZATION_SETTINGS,
      key,
    )
      ? UPDATABLE_ORGANIZATION_SETTINGS[key]
      : undefined;
    if (value === undefined || sameValue(value, current[key])) {
      // Unveraendert zurueckgeschickt: nichts zu tun. Bei aenderbaren
      // Abschnitten trotzdem stehen lassen — die Normalisierung danach
      // (z. B. rechtliche Angaben) soll denselben Weg nehmen wie bisher.
      if (!check) delete incoming[key];
      continue;
    }
    if (!check) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.ORGANIZATION_SETTING_NOT_UPDATABLE,
        message: `Die Einstellung „${key}“ lässt sich hier nicht ändern.`,
        params: { key },
        details: [{ field: `settings.${key}`, code: 'notUpdatable' }],
      });
    }
    const problem = check(value);
    if (problem) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.ORGANIZATION_SETTINGS_INVALID,
        message: `Die Einstellung „${key}“ ist ungültig.`,
        params: { key },
        details: [
          { field: `settings.${key}`, code: 'invalid', expected: problem },
        ],
      });
    }
  }
  return incoming;
}

/** Drucker- und Vorlagen-IDs, auf die der Bestellablauf verweist. */
export function orderFlowReferences(orderFlow: unknown): {
  printerIds: string[];
  templateIds: string[];
} {
  const printerIds = new Set<string>();
  const templateIds = new Set<string>();
  if (orderFlow && typeof orderFlow === 'object') {
    for (const part of Object.values(orderFlow as Record<string, unknown>)) {
      if (!part || typeof part !== 'object') continue;
      const { printerId, templateId } = part as Record<string, unknown>;
      if (typeof printerId === 'string' && printerId) printerIds.add(printerId);
      if (typeof templateId === 'string' && templateId) {
        templateIds.add(templateId);
      }
    }
  }
  return { printerIds: [...printerIds], templateIds: [...templateIds] };
}
