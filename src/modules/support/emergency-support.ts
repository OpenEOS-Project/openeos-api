/**
 * Notfall-Support am Veranstaltungstag (AGB Ziffer 18.2).
 *
 * Fuer kritische Stoerungen waehrend eines gebuchten Nutzungstags gibt es
 * zusaetzlich zu Support-Chat und E-Mail eine Rufnummer. Sie ist nie
 * oeffentlich: nur Mitglieder (und Geraete) einer Organisation sehen sie,
 * und nur solange die Organisation mindestens eine freigeschaltete
 * Veranstaltung hat, die noch nicht beendet ist. Ohne
 * `OPERATOR_EMERGENCY_PHONE` gibt es sie gar nicht — auch nicht auf einer
 * eigenen Installation.
 */
import { EventStatus } from '../../database/entities/event.entity';
import type { EventBillingStatus } from '../../database/entities/event.entity';
import { isEventBillingUnlocked } from '../../database/entities/event.entity';
import type { EventPhaseInfo } from '../../common/utils/event-phase.util';

/** Antwort von `GET …/support/emergency` (Mitglieder und Geraete). */
export interface EmergencySupportInfo {
  /** Rufnummer zum Anzeigen, `null`: nicht anzeigen. */
  phone: string | null;
  /** Fuer den `tel:`-Link (nur `+` und Ziffern), `null` wie `phone`. */
  telUri: string | null;
  /** Veranstaltungen, fuer die der Notfall-Support gerade gilt. */
  eventIds: string[];
}

export const NO_EMERGENCY_SUPPORT: EmergencySupportInfo = {
  phone: null,
  telUri: null,
  eventIds: [],
};

/** Konfigurierte Rufnummer, leer bzw. nur Leerzeichen: `null`. */
export function normalizeEmergencyPhone(
  raw: string | null | undefined,
): string | null {
  const phone = (raw ?? '').replace(/\s+/g, ' ').trim();
  return phone ? phone : null;
}

/** `+49 15678 142392` → `tel:+4915678142392`. */
export function emergencyPhoneTelUri(phone: string): string {
  const compact = phone.replace(/[^\d+]/g, '');
  return `tel:${compact}`;
}

/** Was die Pruefung von einer Veranstaltung braucht. */
export interface EmergencySupportEvent {
  status: EventStatus | `${EventStatus}`;
  billingStatus?: EventBillingStatus | null;
}

/**
 * Gilt der Notfall-Support fuer diese Veranstaltung?
 *
 * - Mit Abrechnung (gehostet): freigeschaltet (bezahlt, auf Rechnung oder
 *   erlassen). Testmodus zaehlt nie — da ist nichts gebucht.
 * - Ohne Abrechnung (eigene Installation mit gesetzter Rufnummer):
 *   aktiv geschaltet.
 * - Noch nicht beendet: mit Verkaufsfenster vor `realSalesUntil` (also
 *   „Geplant“ und „Aktiv“, inklusive Kulanz), ohne Fenster (kein Datum,
 *   Datumsphasen aus) nur solange sie aktiv geschaltet ist.
 */
export function isEmergencySupportEvent(
  event: EmergencySupportEvent,
  phase: Pick<EventPhaseInfo, 'realSalesUntil'>,
  options: { billingEnabled: boolean },
  now: Date = new Date(),
): boolean {
  if (event.status === EventStatus.TEST) return false;
  if (options.billingEnabled) {
    if (!isEventBillingUnlocked(event.billingStatus ?? 'none')) return false;
  } else if (event.status !== EventStatus.ACTIVE) {
    return false;
  }

  if (phase.realSalesUntil) {
    return now.getTime() < Date.parse(phase.realSalesUntil);
  }
  return event.status === EventStatus.ACTIVE;
}
