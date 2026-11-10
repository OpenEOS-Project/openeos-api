/**
 * Welche Erinnerungen bekommt eine Veranstaltung jetzt? Reine Funktion:
 * Zustand der Veranstaltung, Verkaufsfenster, Schalter der Organisation und
 * Uhrzeit rein, faellige Mails raus. Ob eine Mail fuer diesen Termin schon
 * verschickt wurde, entscheidet danach der Merker in `event_notifications`.
 *
 * Regeln:
 * - Geloeschte Veranstaltungen kommen gar nicht erst an (Abfrage); inaktive
 *   bekommen keine Erinnerung vor dem Fest.
 * - `week_before` / `day_before`: gebucht (freigeschaltet: bezahlt, auf
 *   Rechnung, erlassen) — ohne Abrechnung (eigene Installation): aktiv.
 *   Nur vor dem Verkaufsstart (das Zeitfenster endet spaetestens dort).
 * - `after_event`: gebucht bzw. ohne Abrechnung nicht im Testmodus; ob es
 *   echte Bestellungen gab, prueft der Versand (sonst kein Rueckblick).
 * - `not_booked`: nur mit Abrechnung, Testmodus, nie freigeschaltet und nie
 *   storniert, schon vor dem Faelligkeitstag angelegt (eine heute angelegte
 *   Veranstaltung wird nicht sofort angemahnt).
 */
import type { SalesWindow } from '../../common/utils/event-phase.util';
import {
  EVENT_UNLOCKED_BILLING_STATUSES,
  type EventBillingStatus,
} from '../../database/entities/event.entity';
import type { EventNotificationKind } from '../../database/entities/event-notification.entity';
import { isReminderEnabled } from './event-notification-settings';
import {
  isDue,
  scheduleFor,
  type ReminderSchedule,
} from './event-notification-schedule';

export interface PlanEvent {
  status: string;
  billingStatus: string | null;
  createdAt: Date;
  /** Gab es schon einmal einen Storno der Freischaltung? */
  hadCancellation: boolean;
}

export interface PlanContext {
  billingEnabled: boolean;
  timeZone: string;
  organizationSettings: object | null | undefined;
  now: Date;
}

export type PlanSkip = 'disabled' | 'not_eligible' | 'not_due';

export const REMINDER_KINDS: readonly EventNotificationKind[] = [
  'not_booked',
  'week_before',
  'day_before',
  'after_event',
];

/** Darf diese Art von Mail ueberhaupt an diese Veranstaltung gehen? */
export function isEligible(
  kind: EventNotificationKind,
  event: PlanEvent,
  billingEnabled: boolean,
): boolean {
  const unlocked = EVENT_UNLOCKED_BILLING_STATUSES.includes(
    (event.billingStatus ?? 'none') as EventBillingStatus,
  );
  switch (kind) {
    case 'week_before':
    case 'day_before':
      if (event.status === 'inactive') return false;
      return billingEnabled ? unlocked : event.status === 'active';
    case 'after_event':
      return billingEnabled ? unlocked : event.status !== 'test';
    case 'not_booked':
      return (
        billingEnabled &&
        event.status === 'test' &&
        (event.billingStatus ?? 'none') === 'none' &&
        !event.hadCancellation
      );
  }
}

/** Die jetzt faelligen Erinnerungen fuer eine Veranstaltung. */
export function dueReminders(
  event: PlanEvent,
  window: SalesWindow,
  ctx: PlanContext,
): ReminderSchedule[] {
  const result: ReminderSchedule[] = [];
  for (const kind of REMINDER_KINDS) {
    const { schedule } = planReminder(kind, event, window, ctx);
    if (schedule) result.push(schedule);
  }
  return result;
}

/** Entscheidung fuer eine Art, mit Grund (fuer Tests und Protokoll). */
export function planReminder(
  kind: EventNotificationKind,
  event: PlanEvent,
  window: SalesWindow,
  ctx: PlanContext,
): { schedule: ReminderSchedule | null; skip: PlanSkip | null } {
  if (!isEligible(kind, event, ctx.billingEnabled)) {
    return { schedule: null, skip: 'not_eligible' };
  }
  if (!isReminderEnabled(ctx.organizationSettings, kind)) {
    return { schedule: null, skip: 'disabled' };
  }
  const schedule = scheduleFor(kind, window, ctx.timeZone);
  if (!isDue(schedule, ctx.now, ctx.timeZone)) {
    return { schedule: null, skip: 'not_due' };
  }
  if (
    kind === 'not_booked' &&
    event.createdAt.getTime() > schedule.dueAt.getTime()
  ) {
    return { schedule: null, skip: 'not_eligible' };
  }
  return { schedule, skip: null };
}
