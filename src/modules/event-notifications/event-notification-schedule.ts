/**
 * Wann geht welche Erinnerung zu einer Veranstaltung raus?
 *
 * Reine Funktionen ohne Datenbank; die Zeiten sind Wanduhrzeiten in der
 * Zeitzone der Organisation (Standard Europe/Berlin), also auch in der
 * Woche der Zeitumstellung „9 Uhr“ und nicht „8 Uhr UTC“.
 *
 * | Art           | Faellig ab                                    | Spaetestens (Nachholen)          |
 * |---------------|-----------------------------------------------|----------------------------------|
 * | `week_before` | 9 Uhr, 7 Kalendertage vor dem ersten Festtag  | 5 Tage vor dem ersten Festtag    |
 * | `not_booked`  | 9 Uhr, 10 Kalendertage vor dem ersten Festtag | 8 Tage vor dem ersten Festtag    |
 * | `day_before`  | 9 Uhr am Tag des Verkaufsstarts, liegt der vor 12 Uhr: 9 Uhr am Vortag | Verkaufsstart (`realSalesFrom`) |
 * | `after_event` | Ende des Verkaufsfensters samt Kulanz, frühestens 9 Uhr, nach 20 Uhr erst am naechsten Morgen | 7 Tage danach |
 *
 * Hat der Lauf die genaue Zeit verpasst (Ausfall, Deployment, spaet
 * gebucht), wird nachgeholt, solange die Mail noch Sinn ergibt — danach
 * nie mehr. Zwischen 21 und 7 Uhr wird nicht verschickt; nur die
 * Vortag-Mail geht auch nachts raus, wenn der Verkauf vor 7 Uhr beginnt.
 *
 * `scheduleKey` ist der Kalendertag, auf den sich die Mail bezieht (erster
 * Festtag; nach dem Fest der letzte). Wird das Fest auf einen anderen Tag
 * verschoben, aendert sich der Schluessel, und die Mail geht fuer den
 * neuen Termin noch einmal raus. Eine andere Uhrzeit am selben Tag loest
 * keine zweite Mail aus.
 */
import type { SalesWindow } from '../../common/utils/event-phase.util';
import {
  dayBoundsInZone,
  shiftCalendarDaysInZone,
  shiftWallClockHours,
  toDateKey,
} from '../../common/utils/event-schedule.util';
import type { EventNotificationKind } from '../../database/entities/event-notification.entity';

/** Uhrzeit, zu der die Erinnerungen normalerweise rausgehen. */
export const REMINDER_HOUR = 9;
/** Die Woche-vorher-Mail: so viele Kalendertage vor dem ersten Festtag … */
export const WEEK_BEFORE_DAYS = 7;
/** … und nachgeholt hoechstens bis so viele Tage vorher. */
export const WEEK_BEFORE_LATEST_DAYS = 5;
/**
 * „Noch nicht freigeschaltet“: frueher als die Woche-vorher-Mail, damit
 * nach dem Buchen noch kostenlos storniert werden kann (bis 7 Kalendertage
 * vor Beginn, siehe `cancellationDeadline`) …
 */
export const NOT_BOOKED_DAYS = 10;
/** … und nachgeholt nur, solange diese Frist noch mindestens einen Tag laeuft. */
export const NOT_BOOKED_LATEST_DAYS = 8;
/** Der Rueckblick wird hoechstens so viele Tage nach dem Fest nachgeholt. */
export const AFTER_EVENT_MAX_DAYS = 7;
/** Nach dieser Stunde kein Rueckblick mehr am selben Tag. */
export const AFTER_EVENT_LATEST_HOUR = 20;
/** Ruhezeit: nur zwischen diesen Stunden verschicken (Ortszeit). */
export const SEND_FROM_HOUR = 7;
export const SEND_UNTIL_HOUR = 21;

export interface ReminderSchedule {
  kind: EventNotificationKind;
  /** Ab hier faellig. */
  dueAt: Date;
  /** Ab hier veraltet — nicht mehr verschicken. */
  validUntil: Date;
  /** Kalendertag des Termins (JJJJ-MM-TT), Teil des Merkers. */
  scheduleKey: string;
}

/** Stunde der Wanduhr in `timeZone`. */
export function localHour(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
}

/** Der Kalendertag von `date`, um `hour` Uhr Ortszeit. */
export function atLocalHour(date: Date, hour: number, timeZone: string): Date {
  const { start } = dayBoundsInZone(date, timeZone);
  return shiftWallClockHours(start, hour, timeZone);
}

/** Termin einer Erinnerung aus dem Verkaufsfenster der Veranstaltung. */
export function scheduleFor(
  kind: EventNotificationKind,
  window: Pick<
    SalesWindow,
    | 'businessDaysFrom'
    | 'businessDaysUntil'
    | 'realSalesFrom'
    | 'realSalesUntil'
  >,
  timeZone: string,
): ReminderSchedule {
  const firstDay = window.businessDaysFrom;
  const firstDayKey = toDateKey(firstDay, timeZone);

  switch (kind) {
    case 'week_before':
    case 'not_booked': {
      const [days, latestDays] =
        kind === 'not_booked'
          ? [NOT_BOOKED_DAYS, NOT_BOOKED_LATEST_DAYS]
          : [WEEK_BEFORE_DAYS, WEEK_BEFORE_LATEST_DAYS];
      return {
        kind,
        dueAt: atLocalHour(
          shiftCalendarDaysInZone(firstDay, -days, timeZone),
          REMINDER_HOUR,
          timeZone,
        ),
        validUntil: shiftCalendarDaysInZone(firstDay, -latestDays, timeZone),
        scheduleKey: firstDayKey,
      };
    }

    case 'day_before': {
      const salesFrom = window.realSalesFrom;
      // Verkaufsstart am Abend (Standard: 18 Uhr am Vorabend) → Mail am
      // Morgen desselben Tages; Start am Morgen → am Vortag.
      const sameDay = localHour(salesFrom, timeZone) >= 12;
      const base = sameDay
        ? salesFrom
        : shiftCalendarDaysInZone(salesFrom, -1, timeZone);
      return {
        kind,
        dueAt: atLocalHour(base, REMINDER_HOUR, timeZone),
        validUntil: salesFrom,
        scheduleKey: firstDayKey,
      };
    }

    case 'after_event': {
      const until = window.realSalesUntil;
      const hour = localHour(until, timeZone);
      let dueAt = until;
      if (hour < REMINDER_HOUR) {
        dueAt = atLocalHour(until, REMINDER_HOUR, timeZone);
      } else if (hour >= AFTER_EVENT_LATEST_HOUR) {
        dueAt = atLocalHour(
          shiftCalendarDaysInZone(until, 1, timeZone),
          REMINDER_HOUR,
          timeZone,
        );
      }
      return {
        kind,
        dueAt,
        validUntil: shiftCalendarDaysInZone(
          until,
          AFTER_EVENT_MAX_DAYS,
          timeZone,
        ),
        // Letzter Festtag: der Geschaeftstag vor dem Ende des Fensters.
        scheduleKey: toDateKey(
          shiftCalendarDaysInZone(window.businessDaysUntil, -1, timeZone),
          timeZone,
        ),
      };
    }
  }
}

/** Liegt `now` in der Versandzeit (7 bis 21 Uhr Ortszeit)? */
export function inSendHours(now: Date, timeZone: string): boolean {
  const hour = localHour(now, timeZone);
  return hour >= SEND_FROM_HOUR && hour < SEND_UNTIL_HOUR;
}

/** Naechster Beginn der Versandzeit ab `now` (7 Uhr heute oder morgen). */
export function nextSendStart(now: Date, timeZone: string): Date {
  const today = atLocalHour(now, SEND_FROM_HOUR, timeZone);
  if (today.getTime() > now.getTime()) return today;
  return atLocalHour(
    shiftCalendarDaysInZone(now, 1, timeZone),
    SEND_FROM_HOUR,
    timeZone,
  );
}

/**
 * Soll die Erinnerung jetzt raus? Faellig, noch nicht veraltet und in der
 * Versandzeit — ausserhalb nur die Vortag-Mail, wenn sie bis 7 Uhr
 * veraltet waere (Verkaufsstart in der Nacht).
 */
export function isDue(
  schedule: ReminderSchedule,
  now: Date,
  timeZone: string,
): boolean {
  const t = now.getTime();
  if (t < schedule.dueAt.getTime()) return false;
  if (t >= schedule.validUntil.getTime()) return false;
  if (inSendHours(now, timeZone)) return true;
  if (schedule.kind !== 'day_before') return false;
  return (
    nextSendStart(now, timeZone).getTime() >= schedule.validUntil.getTime()
  );
}
