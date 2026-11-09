/**
 * Phasen einer Veranstaltung (Entscheidung 2026-11-08).
 *
 * Bis hierher entschied allein `events.status`, ob eine Veranstaltung
 * verkauft: eine freigeschaltete Veranstaltung war ab dem Aktivieren
 * „aktiv“ und nahm echte Bestellungen an — Wochen vor ihrem Termin und
 * unbegrenzt danach. Jetzt kommt der Zeitraum dazu. Die Phase wird nicht
 * gespeichert, sondern abgeleitet: aus Status, Abrechnung, Beginn und Ende,
 * der Uhrzeit und der Konfiguration.
 *
 * | Phase      | Wann                                         | Verkauf                         |
 * |------------|----------------------------------------------|---------------------------------|
 * | `inactive` | Status `inactive`                            | keiner                          |
 * | `test`     | Status `test` (vor dem Kauf)                 | Testbestellungen (Deckel)       |
 * | `planned`  | aktiv + freigeschaltet, vor `realSalesFrom`  | Testbestellungen; Shop nur mit Vorverkauf (dann echt) |
 * | `active`   | `realSalesFrom` bis `realSalesUntil`         | echt                            |
 * | `ended`    | ab `realSalesUntil`                          | keine neuen Bestellungen; Kassieren, Erstatten, Tische schliessen geht weiter |
 *
 * Das Fenster fuer echte Verkaeufe:
 * - beginnt `earlyStartHours` (Standard 12, `EVENT_EARLY_START_HOURS`) vor
 *   dem ersten Geschaeftstag — „16.11.“ heisst: echt ab 15.11. 18 Uhr;
 * - endet `graceHours` (Standard 6, `EVENT_GRACE_HOURS`) nach dem Ende des
 *   letzten Geschaeftstags — „17.11.“ endet am 18.11. um 6 Uhr, verkauft
 *   wird bis 12 Uhr (Kulanz fuer spaete Deckel).
 * Beide Zugaben kosten nichts; abgerechnet werden die Geschaeftstage.
 *
 * Cloud-TSE (Deutschland, „Alle Funktionen“): der Vorlauf reicht nie in den
 * Vormonat. Eine TSE kostet jeden Kalendermonat, in dem sie aktiv war, und
 * wird am Monatsletzten um 20 Uhr abgemeldet — ein Vorabend am 31. hiesse
 * entweder ein ganzer Zusatzmonat fuer ein paar Stunden oder eine Kasse, der
 * um 20 Uhr die TSE wegbricht. Echte Verkaeufe beginnen dann am 1. um
 * 0 Uhr (`earlyStartLimitedByMonth`).
 *
 * Ohne Datum, im Bestand ohne Freischaltung (vor der Abrechnung aktiviert)
 * und mit `EVENT_DATE_PHASES=false` bleibt es beim Status: aktiv ist aktiv.
 */
import {
  eventBusinessSpan,
  shiftWallClockHours,
  startOfMonthInZone,
} from './event-schedule.util';

export const EVENT_PHASES = [
  'inactive',
  'test',
  'planned',
  'active',
  'ended',
] as const;
export type EventPhase = (typeof EVENT_PHASES)[number];

/** Kanal einer neuen Bestellung — der Shop hat im Geplant-Zustand eigene Regeln. */
export type OrderChannel = 'pos' | 'table' | 'qr' | 'shop' | 'admin';

export interface EventPhaseSettings {
  /** `EVENT_DATE_PHASES` (Standard an). Aus: nur der Status zaehlt. */
  enabled: boolean;
  /** Kostenpflichtige Freischaltung (SaaS). Eigene Installation: aus. */
  billingEnabled: boolean;
  /** Tageswechsel (`BUSINESS_DAY_START_HOUR`, Standard 6). */
  dayStartHour: number;
  /** Vorlauf vor dem ersten Geschaeftstag (`EVENT_EARLY_START_HOURS`). */
  earlyStartHours: number;
  /** Obergrenze fuer den Vorlauf je Veranstaltung (`EVENT_EARLY_START_MAX_HOURS`). */
  maxEarlyStartHours: number;
  /** Kulanz nach dem letzten Geschaeftstag (`EVENT_GRACE_HOURS`). */
  graceHours: number;
}

export const DEFAULT_EVENT_PHASE_SETTINGS: EventPhaseSettings = {
  enabled: true,
  billingEnabled: true,
  dayStartHour: 6,
  earlyStartHours: 12,
  maxEarlyStartHours: 24,
  graceHours: 6,
};

/** Was die Ableitung von der Veranstaltung braucht. */
export interface EventPhaseEvent {
  status: string;
  billingStatus?: string | null;
  startDate: Date | string | null;
  endDate: Date | string | null;
  settings?: {
    sales?: { earlyStartHours?: unknown; presale?: unknown } | null;
    [key: string]: unknown;
  } | null;
}

/** Was die Ableitung von der Organisation braucht. */
export interface EventPhaseOrganization {
  timezone?: string | null;
  /**
   * Verkauft die Organisation mit Cloud-TSE (DE, Integration `tse` an,
   * nicht „Nur Bons“)? Dann reicht der Vorlauf nicht in den Vormonat.
   */
  usesCloudTse?: boolean;
}

export interface EventPhaseInfo {
  phase: EventPhase;
  /** Gelten die Datumsphasen fuer diese Veranstaltung? */
  datePhases: boolean;
  /** Ab hier echte Verkaeufe (ISO), `null` ohne Datumsphasen. */
  realSalesFrom: string | null;
  /** Ab hier keine neuen Bestellungen mehr (ISO), `null` ohne Datumsphasen. */
  realSalesUntil: string | null;
  /** Beginn des ersten / Ende des letzten Geschaeftstags (ISO). */
  businessDaysFrom: string | null;
  businessDaysUntil: string | null;
  /** Wirksamer Vorlauf in Stunden (Einstellung der Veranstaltung oder Standard). */
  earlyStartHours: number;
  /** Wirksame Kulanz in Stunden. */
  graceHours: number;
  /** Vorlauf an der Monatsgrenze gekuerzt (Cloud-TSE). */
  earlyStartLimitedByMonth: boolean;
  /** Vorverkauf im Shop eingeschaltet (`settings.sales.presale`). */
  presaleEnabled: boolean;
  /** Nimmt der Shop gerade echte Vorverkaufs-Bestellungen an? */
  presaleActive: boolean;
  /**
   * Beginn und Ende lassen sich nicht mehr frei verschieben: das
   * Verkaufsfenster hat begonnen (freigeschaltet, mit Abrechnung).
   */
  datesLocked: boolean;
}

const DEFAULT_TIME_ZONE = 'Europe/Berlin';

function clampHours(value: unknown, max: number): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.min(Math.max(0, n), Math.max(0, max));
}

/** Vorlauf der Veranstaltung: eigene Einstellung (0..max) oder Standard. */
export function effectiveEarlyStartHours(
  event: Pick<EventPhaseEvent, 'settings'>,
  settings: EventPhaseSettings,
): number {
  const own = clampHours(
    event.settings?.sales?.earlyStartHours,
    settings.maxEarlyStartHours,
  );
  if (own !== null) return own;
  return clampHours(settings.earlyStartHours, settings.maxEarlyStartHours) ?? 0;
}

export function isPresaleEnabled(
  event: Pick<EventPhaseEvent, 'settings'>,
): boolean {
  return event.settings?.sales?.presale === true;
}

/**
 * Gelten fuer diese Veranstaltung die Datumsphasen? Nur aktiv geschaltet,
 * mit Datum und — mit Abrechnung — freigeschaltet. Eine im Bestand ohne
 * Freischaltung aktivierte Veranstaltung verhaelt sich wie bisher.
 */
export function usesDatePhases(
  event: EventPhaseEvent,
  settings: EventPhaseSettings,
): boolean {
  if (!settings.enabled || !event.startDate) return false;
  if (!settings.billingEnabled) return true;
  return ['paid', 'invoice', 'waived'].includes(event.billingStatus ?? '');
}

export interface SalesWindow {
  businessDaysFrom: Date;
  businessDaysUntil: Date;
  realSalesFrom: Date;
  realSalesUntil: Date;
  earlyStartHours: number;
  graceHours: number;
  earlyStartLimitedByMonth: boolean;
}

/** Das Fenster fuer echte Verkaeufe, unabhaengig vom Status. */
export function salesWindow(
  event: Pick<EventPhaseEvent, 'startDate' | 'endDate' | 'settings'>,
  organization: EventPhaseOrganization,
  settings: EventPhaseSettings,
): SalesWindow | null {
  const timeZone = organization.timezone || DEFAULT_TIME_ZONE;
  const span = eventBusinessSpan(
    event.startDate,
    event.endDate,
    timeZone,
    settings.dayStartHour,
  );
  if (!span) return null;

  const earlyStartHours = effectiveEarlyStartHours(event, settings);
  const graceHours = clampHours(settings.graceHours, 24) ?? 0;

  let realSalesFrom = shiftWallClockHours(
    span.from,
    -earlyStartHours,
    timeZone,
  );
  let earlyStartLimitedByMonth = false;
  if (organization.usesCloudTse) {
    // TSE-Monate rechnet Swissbit nach deutscher Zeit; die Organisation
    // einer deutschen TSE liegt ohnehin dort.
    const monthStart = startOfMonthInZone(span.from, 'Europe/Berlin');
    if (realSalesFrom.getTime() < monthStart.getTime()) {
      realSalesFrom =
        monthStart.getTime() < span.from.getTime() ? monthStart : span.from;
      earlyStartLimitedByMonth = true;
    }
  }

  return {
    businessDaysFrom: span.from,
    businessDaysUntil: span.to,
    realSalesFrom,
    realSalesUntil: shiftWallClockHours(span.to, graceHours, timeZone),
    earlyStartHours,
    graceHours,
    earlyStartLimitedByMonth,
  };
}

/** Phase und Verkaufsfenster einer Veranstaltung zum Zeitpunkt `now`. */
export function resolveEventPhase(
  event: EventPhaseEvent,
  organization: EventPhaseOrganization,
  settings: EventPhaseSettings,
  now: Date = new Date(),
): EventPhaseInfo {
  const presaleEnabled = isPresaleEnabled(event);
  const datePhases = usesDatePhases(event, settings);
  const window = datePhases ? salesWindow(event, organization, settings) : null;

  const base = {
    datePhases: !!window,
    realSalesFrom: window?.realSalesFrom.toISOString() ?? null,
    realSalesUntil: window?.realSalesUntil.toISOString() ?? null,
    businessDaysFrom: window?.businessDaysFrom.toISOString() ?? null,
    businessDaysUntil: window?.businessDaysUntil.toISOString() ?? null,
    earlyStartHours:
      window?.earlyStartHours ?? effectiveEarlyStartHours(event, settings),
    graceHours: window?.graceHours ?? settings.graceHours,
    earlyStartLimitedByMonth: window?.earlyStartLimitedByMonth ?? false,
    presaleEnabled,
  };

  // Ohne Abrechnung (eigene Installation) gibt es keine bezahlte Dauer, die
  // sich durch Verschieben strecken liesse.
  const started = !!window && now.getTime() >= window.realSalesFrom.getTime();
  const datesLocked = settings.billingEnabled && started;

  let phase: EventPhase;
  if (event.status === 'inactive') phase = 'inactive';
  else if (event.status === 'test') phase = 'test';
  else if (!window) phase = 'active';
  else if (now.getTime() < window.realSalesFrom.getTime()) phase = 'planned';
  else if (now.getTime() >= window.realSalesUntil.getTime()) phase = 'ended';
  else phase = 'active';

  return {
    ...base,
    phase,
    presaleActive: phase === 'planned' && presaleEnabled,
    datesLocked,
  };
}

/** Werden Bestellungen in dieser Phase als Testbestellung gebucht? */
export function isTestPhase(phase: EventPhase): boolean {
  return phase === 'test' || phase === 'planned';
}

/**
 * Wie wird eine neue Bestellung ueber `channel` gebucht?
 * - `reject`: gar nicht (inaktiv, beendet; Shop im Geplant-Zustand ohne
 *   Vorverkauf),
 * - `test`: als Testbestellung,
 * - `real`: als echte Bestellung.
 */
export function orderModeFor(
  info: Pick<EventPhaseInfo, 'phase' | 'presaleEnabled'>,
  channel: OrderChannel,
): 'reject' | 'test' | 'real' {
  switch (info.phase) {
    case 'inactive':
    case 'ended':
      return 'reject';
    case 'test':
      return 'test';
    case 'planned':
      if (channel === 'shop') return info.presaleEnabled ? 'real' : 'reject';
      return 'test';
    default:
      return 'real';
  }
}
