/**
 * Lebenszyklus `monthly` (Entscheidung 2026-11-04, tse-swissbit-plan.md
 * §8.3): Eine TSE laeuft fuer den Kalendermonat ihrer Veranstaltung und
 * wird zum Monatsende automatisch abgemeldet. Swissbit berechnet volle
 * Monate; abgemeldet werden muss deshalb sicher **vor** dem Monatswechsel.
 *
 * Reine Zeitregeln (Europe/Berlin) — ohne Datenbank, gut testbar.
 */
import {
  TSE_TIME_ZONE,
  berlinTime,
  businessDayEnd,
  localParts,
} from './tse-dates';
import { eventBusinessSpan } from '../../common/utils/event-schedule.util';

/** Geplante Abmeldung: letzter Tag des Monats um 20:00 Uhr (Berlin). */
export const DEACTIVATION_HOUR = 20;
/** Ab hier (18:00) bereitet der Lauf die Abmeldung vor (Abschlussexport). */
export const PREPARE_BEFORE_MS = 2 * 3600_000;
/**
 * Ab hier (21:00) wird auch ohne fertigen Abschlussexport abgemeldet —
 * Swissbit exportiert den Rest bei der Abmeldung selbst, die Abmeldung vor
 * dem Monatswechsel hat Vorrang.
 */
export const EXPORT_GRACE_MS = 3600_000;
/** Ab hier (22:00) ist die Abmeldung ueberfaellig: Warnung an den Betreiber. */
export const ALERT_AFTER_MS = 2 * 3600_000;

/** Wartezeit nach dem n-ten gescheiterten Abmeldeversuch (Backoff). */
const BACKOFF_MS = [5, 10, 15, 30, 60].map((m) => m * 60_000);

export function backoffMs(attempts: number): number {
  const index = Math.max(0, Math.min(attempts - 1, BACKOFF_MS.length - 1));
  return BACKOFF_MS[index];
}

/** Anzahl Tage im Monat (`month` 1..12). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Geplante Abmeldung fuer den Kalendermonat (Berlin), in dem `at` liegt. */
export function plannedDeactivationFor(at: Date): Date {
  const p = localParts(at);
  return berlinTime(
    p.year,
    p.month,
    daysInMonth(p.year, p.month),
    DEACTIVATION_HOUR,
  );
}

/** Geplante Abmeldung am Ende des Folgemonats von `at`. */
export function plannedDeactivationOfNextMonth(at: Date): Date {
  const p = localParts(at);
  const year = p.month === 12 ? p.year + 1 : p.year;
  const month = p.month === 12 ? 1 : p.month + 1;
  return berlinTime(year, month, daysInMonth(year, month), DEACTIVATION_HOUR);
}

/**
 * Neuer Termin, wenn die Abmeldung um `at` nicht stattfinden darf: das
 * Ende des Monats von `at`, falls das noch bevorsteht, sonst das Ende des
 * Folgemonats.
 */
export function postponedDeactivation(at: Date): Date {
  const sameMonth = plannedDeactivationFor(at);
  return sameMonth.getTime() > at.getTime()
    ? sameMonth
    : plannedDeactivationOfNextMonth(at);
}

/** Beginn (00:00 Berlin) des Kalendermonats von `at` und des Folgemonats. */
export function localMonthRange(at: Date): { from: Date; to: Date } {
  const p = localParts(at);
  const year = p.month === 12 ? p.year + 1 : p.year;
  const month = p.month === 12 ? 1 : p.month + 1;
  return {
    from: berlinTime(p.year, p.month, 1),
    to: berlinTime(year, month, 1),
  };
}

/** `YYYY-MM` (Berlin). */
export function monthKey(at: Date): string {
  const p = localParts(at);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

/** Beginn des Geschaeftstags (`startHour` Uhr), in dem `at` liegt. */
export function businessDayStart(at: Date, startHour = 6): Date {
  const p = localParts(at);
  const sameDay = berlinTime(p.year, p.month, p.day, startHour);
  if (sameDay.getTime() <= at.getTime()) return sameDay;
  const previous = new Date(
    berlinTime(p.year, p.month, p.day, 12).getTime() - 24 * 3600_000,
  );
  const q = localParts(previous);
  return berlinTime(q.year, q.month, q.day, startHour);
}

export interface PaidEventSpan {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date | null;
}

/**
 * Geschaeftstage einer Veranstaltung: vom Beginn des Geschaeftstags ihres
 * Starts bis zum Ende des Geschaeftstags ihres Endes (6–6 Uhr).
 *
 * Reine Daten (Beginn und Ende auf Mitternacht, wie das Formular sie
 * schickt) sind die Kalendertage selbst — dieselbe Lesart wie die Phasen
 * der Veranstaltung (`eventBusinessSpan`, 2026-11-08). Vorher lag ein Fest
 * „30.–31.“ fuer die TSE auf dem 29. und 30. (Ende am 31. um 6 Uhr) und
 * waere am Abend des 31. um 20 Uhr abgemeldet worden; ein Fest am 1.
 * zaehlte als laufend am Monatsletzten.
 */
export function businessSpan(
  event: Pick<PaidEventSpan, 'startDate' | 'endDate'>,
  startHour = 6,
): { from: Date; to: Date } {
  const span = eventBusinessSpan(
    event.startDate,
    event.endDate,
    TSE_TIME_ZONE,
    startHour,
  );
  if (span) return { from: span.from, to: span.to };
  return {
    from: businessDayStart(event.startDate, startHour),
    to: businessDayEnd(event.endDate ?? event.startDate, startHour),
  };
}

/**
 * Veranstaltungen, die eine Abmeldung um `at` verhindern: ihre
 * Geschaeftstage laufen zu diesem Zeitpunkt (und gehen damit ggf. in den
 * naechsten Monat weiter).
 */
export function blockingEvents<T extends PaidEventSpan>(
  events: readonly T[],
  at: Date,
  startHour = 6,
): T[] {
  return events.filter((event) => {
    const span = businessSpan(event, startHour);
    return (
      span.from.getTime() <= at.getTime() && span.to.getTime() > at.getTime()
    );
  });
}

/** Veranstaltungen, deren Geschaeftstage den Kalendermonat von `at` beruehren. */
export function eventsInMonth<T extends PaidEventSpan>(
  events: readonly T[],
  at: Date,
  startHour = 6,
): T[] {
  const month = localMonthRange(at);
  return events.filter((event) => {
    const span = businessSpan(event, startHour);
    return (
      span.from.getTime() < month.to.getTime() &&
      span.to.getTime() > month.from.getTime()
    );
  });
}

/** Phase einer aktiven TSE im Monatslauf. */
export type MonthlyPhase = 'idle' | 'prepare' | 'deactivate';

export function monthlyPhase(planned: Date | null, now: Date): MonthlyPhase {
  if (!planned) return 'idle';
  if (now.getTime() >= planned.getTime()) return 'deactivate';
  if (now.getTime() >= planned.getTime() - PREPARE_BEFORE_MS) return 'prepare';
  return 'idle';
}

/** Ist die Abmeldung ueberfaellig (geplant + 2 h, also nach 22:00)? */
export function isDeactivationOverdue(
  planned: Date | null,
  now: Date,
): boolean {
  return !!planned && now.getTime() >= planned.getTime() + ALERT_AFTER_MS;
}

// ------------------------------------------------ Folgemonat (2026-11-06)

/**
 * Beginn (`startHour` Uhr Berlin) des ersten Geschaeftstags im Monat nach
 * dem Monat von `at` und des ersten Geschaeftstags im Monat danach.
 */
function nextMonthBusinessRange(
  at: Date,
  startHour: number,
): { from: Date; to: Date } {
  const next = localParts(localMonthRange(at).to);
  const afterYear = next.month === 12 ? next.year + 1 : next.year;
  const afterMonth = next.month === 12 ? 1 : next.month + 1;
  return {
    from: berlinTime(next.year, next.month, 1, startHour),
    to: berlinTime(afterYear, afterMonth, 1, startHour),
  };
}

/**
 * Bezahlte Veranstaltungen mit mindestens einem Geschaeftstag (6–6 Uhr),
 * der im **Folgemonat** von `at` beginnt (Entscheidung 2026-11-06: dann
 * bleibt die TSE statt abgemeldet und neu angelegt zu werden — spart die
 * Aktivierung und eine Mitteilung ans Finanzamt).
 *
 * Nicht dazu zaehlt der Ueberhang bis 6 Uhr am 1. (Fest am Monatsletzten,
 * Party nach Mitternacht): das ist die Ausnahme „laeuft zum Termin“
 * (`blockingEvents`), deren Zusatzmonat OpenEOS traegt.
 */
export function nextMonthEvents<T extends PaidEventSpan>(
  events: readonly T[],
  at: Date,
  startHour = 6,
): T[] {
  const next = nextMonthBusinessRange(at, startHour);
  return events.filter((event) => {
    const span = businessSpan(event, startHour);
    return (
      span.from.getTime() < next.to.getTime() &&
      span.to.getTime() > next.from.getTime()
    );
  });
}

/** Warum die TSE ueber einen Monatswechsel hinaus aktiv bleibt. */
export type KeepReason = 'paid_event_next_month' | 'paid_event_running';

export interface OutlookMonth<T extends PaidEventSpan = PaidEventSpan> {
  /** Monat, in dem die TSE zusaetzlich aktiv bleibt (`YYYY-MM`). */
  month: string;
  reason: KeepReason;
  events: T[];
}

/**
 * Voraussichtliche Abmeldung ab dem Termin `planned` nach den Regeln des
 * Monatslaufs: laeuft zum Termin eine bezahlte Veranstaltung oder hat der
 * Folgemonat eine, bleibt die TSE einen Monat laenger — so lange, bis ein
 * Monatsende keinen Grund mehr hat (hoechstens `maxMonths` Monate).
 */
export function deactivationOutlook<T extends PaidEventSpan>(
  events: readonly T[],
  planned: Date,
  startHour = 6,
  maxMonths = 24,
): { at: Date; months: OutlookMonth<T>[] } {
  const months: OutlookMonth<T>[] = [];
  let current = planned;
  for (let i = 0; i < maxMonths; i++) {
    const running = blockingEvents(events, current, startHour);
    const booked = running.length
      ? []
      : nextMonthEvents(events, current, startHour);
    if (running.length === 0 && booked.length === 0) break;
    current = plannedDeactivationOfNextMonth(current);
    months.push({
      month: monthKey(current),
      reason: running.length ? 'paid_event_running' : 'paid_event_next_month',
      events: running.length ? running : booked,
    });
  }
  return { at: current, months };
}

/**
 * Eintrag in `tse_units.metadata.keeps` (Entscheidung 2026-11-06): die TSE
 * bleibt zum Monatsende, weil der Verein im Folgemonat schon eine bezahlte
 * Veranstaltung hat. Bis `recheckUntil` (Monatswechsel) prueft jeder Lauf
 * nach; ist die Veranstaltung bis dahin storniert/erstattet, wird der
 * Eintrag widerrufen (`revokedAt`) und die TSE doch abgemeldet.
 */
export interface TseKeep {
  at: string;
  /** Termin, zu dem die TSE sonst abgemeldet worden waere. */
  from: string;
  /** Neuer Termin (Ende des Folgemonats). */
  to: string;
  reason: 'paid_event_next_month';
  /** Monat, in dem die TSE dadurch weiterlaeuft (`YYYY-MM`). */
  month: string;
  events: {
    id: string;
    name: string;
    startDate: string;
    endDate: string | null;
  }[];
  recheckUntil: string;
  revokedAt?: string | null;
}

export function keepsOf(unit: {
  metadata?: Record<string, unknown> | null;
}): TseKeep[] {
  const list = unit.metadata?.keeps;
  return Array.isArray(list) ? (list as TseKeep[]) : [];
}

/** Die Behalten-Entscheidung, die zum aktuellen Termin gefuehrt hat. */
export function currentKeep(unit: {
  metadata?: Record<string, unknown> | null;
  plannedDeactivationAt: Date | null;
}): TseKeep | null {
  const last = keepsOf(unit).at(-1);
  if (!last || last.revokedAt || !unit.plannedDeactivationAt) return null;
  return new Date(last.to).getTime() ===
    new Date(unit.plannedDeactivationAt).getTime()
    ? last
    : null;
}
