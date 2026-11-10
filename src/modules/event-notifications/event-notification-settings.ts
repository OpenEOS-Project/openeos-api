import type { EventNotificationKind } from '../../database/entities/event-notification.entity';

/**
 * Schalter „Erinnerungen zu Veranstaltungen“ der Organisation
 * (`organizations.settings.eventReminders`), je Mail einer. Fehlt ein
 * Wert, ist die Mail an.
 */
export interface EventReminderSettings {
  /** „Dein Fest rückt näher“ mit Checkliste, 7 Tage vorher. */
  weekBefore?: boolean;
  /** „Morgen geht's los“, am Tag vor dem Verkaufsstart. */
  dayBefore?: boolean;
  /** „Danke! So lief dein Fest“, nach dem Fest. */
  afterEvent?: boolean;
  /** „Noch nicht freigeschaltet“, 7 Tage vorher (nur mit Abrechnung). */
  notBooked?: boolean;
}

export const EVENT_REMINDER_SETTING_KEYS: Record<
  EventNotificationKind,
  keyof EventReminderSettings
> = {
  week_before: 'weekBefore',
  day_before: 'dayBefore',
  after_event: 'afterEvent',
  not_booked: 'notBooked',
};

const KEYS = Object.values(EVENT_REMINDER_SETTING_KEYS);

/** Nur die bekannten Schalter, nur echte Wahrheitswerte. */
export function normalizeEventReminderSettings(
  value: unknown,
): EventReminderSettings {
  const result: EventReminderSettings = {};
  if (!value || typeof value !== 'object') return result;
  for (const key of KEYS) {
    const raw = (value as Record<string, unknown>)[key];
    if (typeof raw === 'boolean') result[key] = raw;
  }
  return result;
}

/** Ist die Mail fuer die Organisation eingeschaltet (Standard an)? */
export function isReminderEnabled(
  settings: object | null | undefined,
  kind: EventNotificationKind,
): boolean {
  const reminders = (settings as { eventReminders?: unknown } | null)
    ?.eventReminders;
  if (!reminders || typeof reminders !== 'object') return true;
  return (
    (reminders as Record<string, unknown>)[
      EVENT_REMINDER_SETTING_KEYS[kind]
    ] !== false
  );
}

/**
 * Will der Admin persoenlich Erinnerungen? Nein, wenn er E-Mail-
 * Benachrichtigungen allgemein oder die Erinnerungen ausgeschaltet hat.
 */
export function userWantsEventReminders(
  preferences: { notifications?: Record<string, unknown> | null } | null,
): boolean {
  const n = preferences?.notifications;
  if (!n || typeof n !== 'object') return true;
  return n.email !== false && n.eventReminders !== false;
}
