/**
 * Abschnitte in `organizations.settings` von Integrationen, die es nicht
 * mehr gibt. PayPal ist seit 1.8 entfernt: Zugangsdaten (`settings.paypal`,
 * darin das verschluesselte `clientSecret`) und ein etwaiger Schalter
 * (`settings.integrations.paypal`) werden weder gelesen noch gespeichert.
 *
 * Geloescht werden die gespeicherten Werte von der Migration
 * `RemovePayPalSettings` und — fuer Werte, die eine alte Instanz waehrend
 * des Rollouts noch geschrieben hat — vom Abgleich nach dem Start
 * (`IntegrationCredentialsBackfillService`). Beides mehrfach ausfuehrbar.
 */
export const REMOVED_SETTINGS_SECTIONS: readonly string[] = ['paypal'];

type Settings = Record<string, unknown>;

function isPlainObject(value: unknown): value is Settings {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Kopie der Einstellungen ohne die entfernten Abschnitte (oberste Ebene und
 * `integrations.<id>`). Unveraendert zurueck, wenn nichts zu entfernen ist;
 * das Original bleibt unberuehrt.
 */
export function stripRemovedSettings<T>(settings: T): T {
  if (!isPlainObject(settings)) return settings;
  let copy: Settings | undefined;
  for (const section of REMOVED_SETTINGS_SECTIONS) {
    if (Object.prototype.hasOwnProperty.call(settings, section)) {
      copy ??= { ...settings };
      delete copy[section];
    }
    const integrations = (copy ?? settings).integrations;
    if (
      isPlainObject(integrations) &&
      Object.prototype.hasOwnProperty.call(integrations, section)
    ) {
      copy ??= { ...settings };
      const rest = { ...integrations };
      delete rest[section];
      copy.integrations = rest;
    }
  }
  return (copy ?? settings) as T;
}

/**
 * Entfernt die Abschnitte direkt in der Datenbank (alle Organisationen,
 * auch geloeschte). Mehrfach ausfuehrbar; `$1` = REMOVED_SETTINGS_SECTIONS.
 */
export const DELETE_REMOVED_SETTINGS_SQL = `
  UPDATE organizations
     SET settings = (settings - $1::text[])
         || CASE
              WHEN jsonb_typeof(settings -> 'integrations') = 'object'
              THEN jsonb_build_object('integrations', (settings -> 'integrations') - $1::text[])
              ELSE '{}'::jsonb
            END
   WHERE jsonb_typeof(settings) = 'object'
     AND (settings ?| $1::text[]
          OR (jsonb_typeof(settings -> 'integrations') = 'object'
              AND (settings -> 'integrations') ?| $1::text[]))
  RETURNING id`;
