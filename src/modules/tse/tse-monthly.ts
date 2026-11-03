/**
 * Lebenszyklus `monthly` (Entscheidung 2026-11-04, tse-swissbit-plan.md
 * §8.3): Eine TSE laeuft fuer den Kalendermonat ihrer Veranstaltung und
 * wird zum Monatsende automatisch abgemeldet. Swissbit berechnet volle
 * Monate; abgemeldet werden muss deshalb sicher **vor** dem Monatswechsel.
 *
 * Reine Zeitregeln (Europe/Berlin) — ohne Datenbank, gut testbar.
 */
import { berlinTime, businessDayEnd, localParts } from './tse-dates';

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
 */
export function businessSpan(
  event: Pick<PaidEventSpan, 'startDate' | 'endDate'>,
  startHour = 6,
): { from: Date; to: Date } {
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
