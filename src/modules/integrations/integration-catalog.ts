import { ForbiddenException } from '@nestjs/common';
import { ErrorCodes } from '../../common/constants/error-codes';

/**
 * Integrationen, die eine Organisation ein- und ausschalten kann.
 *
 * Bewusst eine feste Liste statt freier Schluessel: der Schalter landet in
 * den frei formbaren Einstellungen (`settings.integrations.<id>`), und ohne
 * Liste koennte jeder Admin dort beliebige Eintraege anlegen. Eine neue
 * Integration (fiskaly, stripe) kommt hier dazu und wird an ihren Endpunkten
 * mit `assertIntegrationEnabled` abgesichert.
 */
export const INTEGRATION_IDS = ['sumup'] as const;

export type IntegrationId = (typeof INTEGRATION_IDS)[number];

export function isKnownIntegration(id: string): id is IntegrationId {
  return (INTEGRATION_IDS as readonly string[]).includes(id);
}

/**
 * Ist die Integration fuer die Organisation eingeschaltet?
 *
 * Nur ein ausdrueckliches `enabled === true` zaehlt. Fehlt der Eintrag,
 * gilt die Integration als aus — auch wenn Zugangsdaten hinterlegt sind.
 * Bestandsorganisationen mit eingerichtetem SumUp hat die Migration
 * AddIntegrationActivation eingeschaltet, sonst waeren sie mit dem Update
 * still ohne Kartenzahlung gewesen.
 */
export function isIntegrationEnabled(
  settings: object | null | undefined,
  id: IntegrationId,
): boolean {
  const integrations = (settings as { integrations?: unknown } | null)
    ?.integrations;
  if (!integrations || typeof integrations !== 'object') return false;
  const entry = (integrations as Record<string, unknown>)[id];
  if (!entry || typeof entry !== 'object') return false;
  return (entry as { enabled?: unknown }).enabled === true;
}

/**
 * Weist jeden Aufruf einer ausgeschalteten Integration mit 403 ab.
 *
 * Die Pruefung gehoert an den Endpunkt und nicht nur in die Oberflaeche:
 * die Kasse und Skripte rufen die API direkt auf, und eine ausgeschaltete
 * Integration darf auch mit noch hinterlegten Zugangsdaten nichts tun.
 */
export function assertIntegrationEnabled(
  settings: object | null | undefined,
  id: IntegrationId,
): void {
  if (isIntegrationEnabled(settings, id)) return;
  throw new ForbiddenException({
    code: ErrorCodes.INTEGRATION_DISABLED,
    message: 'Diese Integration ist für die Organisation nicht aktiviert',
  });
}
