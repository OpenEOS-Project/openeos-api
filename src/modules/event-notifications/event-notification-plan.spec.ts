import {
  DEFAULT_EVENT_PHASE_SETTINGS,
  salesWindow,
  type SalesWindow,
} from '../../common/utils/event-phase.util';
import {
  dueReminders,
  isEligible,
  planReminder,
  type PlanEvent,
} from './event-notification-plan';
import {
  isReminderEnabled,
  normalizeEventReminderSettings,
  userWantsEventReminders,
} from './event-notification-settings';

const TZ = 'Europe/Berlin';
const WINDOW = salesWindow(
  {
    startDate: '2026-11-15T23:00:00.000Z',
    endDate: '2026-11-16T23:00:00.000Z',
  },
  { timezone: TZ },
  DEFAULT_EVENT_PHASE_SETTINGS,
) as SalesWindow;

const WEEK_BEFORE = new Date('2026-11-09T09:00:00Z'); // 10 Uhr MEZ
const DAY_BEFORE = new Date('2026-11-15T09:00:00Z');
const AFTER = new Date('2026-11-18T12:00:00Z');

function event(overrides: Partial<PlanEvent> = {}): PlanEvent {
  return {
    status: 'active',
    billingStatus: 'paid',
    createdAt: new Date('2026-10-01T10:00:00Z'),
    hadCancellation: false,
    ...overrides,
  };
}

function kinds(e: PlanEvent, now: Date, billingEnabled = true, settings = {}) {
  return dueReminders(e, WINDOW, {
    billingEnabled,
    timeZone: TZ,
    organizationSettings: settings,
    now,
  }).map((s) => s.kind);
}

describe('isEligible', () => {
  it('gebucht: Woche, Vortag, Rueckblick — nicht „noch nicht freigeschaltet“', () => {
    for (const billing of ['paid', 'invoice', 'waived']) {
      const e = event({ billingStatus: billing });
      expect(isEligible('week_before', e, true)).toBe(true);
      expect(isEligible('day_before', e, true)).toBe(true);
      expect(isEligible('after_event', e, true)).toBe(true);
      expect(isEligible('not_booked', e, true)).toBe(false);
    }
  });

  it('gebucht, aber noch im Testmodus: Checkliste ja (sagt „aktivieren“)', () => {
    const e = event({ status: 'test', billingStatus: 'paid' });
    expect(isEligible('week_before', e, true)).toBe(true);
  });

  it('inaktiv: keine Erinnerung vor dem Fest', () => {
    const e = event({ status: 'inactive' });
    expect(isEligible('week_before', e, true)).toBe(false);
    expect(isEligible('day_before', e, true)).toBe(false);
  });

  it('Testmodus ohne Buchung: nur „noch nicht freigeschaltet“', () => {
    const e = event({ status: 'test', billingStatus: 'none' });
    expect(isEligible('not_booked', e, true)).toBe(true);
    expect(isEligible('week_before', e, true)).toBe(false);
    expect(isEligible('day_before', e, true)).toBe(false);
    expect(isEligible('after_event', e, true)).toBe(false);
  });

  it('Zahlung laeuft oder schon einmal storniert: keine Mahnung', () => {
    expect(
      isEligible(
        'not_booked',
        event({ status: 'test', billingStatus: 'pending' }),
        true,
      ),
    ).toBe(false);
    expect(
      isEligible(
        'not_booked',
        event({ status: 'test', billingStatus: 'none', hadCancellation: true }),
        true,
      ),
    ).toBe(false);
  });

  it('eigene Installation: Mails 1–3 fuer aktive Veranstaltungen, nie Mail 4', () => {
    const active = event({ billingStatus: 'none' });
    expect(isEligible('week_before', active, false)).toBe(true);
    expect(isEligible('day_before', active, false)).toBe(true);
    expect(isEligible('after_event', active, false)).toBe(true);
    const test = event({ status: 'test', billingStatus: 'none' });
    expect(isEligible('not_booked', test, false)).toBe(false);
    expect(isEligible('week_before', test, false)).toBe(false);
    expect(isEligible('after_event', test, false)).toBe(false);
  });
});

describe('dueReminders', () => {
  it('liefert je Zeitpunkt genau die faellige Mail', () => {
    expect(kinds(event(), WEEK_BEFORE)).toEqual(['week_before']);
    expect(kinds(event(), DAY_BEFORE)).toEqual(['day_before']);
    expect(kinds(event(), AFTER)).toEqual(['after_event']);
    expect(kinds(event(), new Date('2026-11-12T09:00:00Z'))).toEqual([]);
  });

  it('Testmodus: „noch nicht freigeschaltet“ zur Woche vorher', () => {
    const e = event({ status: 'test', billingStatus: 'none' });
    expect(kinds(e, WEEK_BEFORE)).toEqual(['not_booked']);
    expect(kinds(e, DAY_BEFORE)).toEqual([]);
  });

  it('erst nach dem Faelligkeitstag angelegt: keine sofortige Mahnung', () => {
    const e = event({
      status: 'test',
      billingStatus: 'none',
      createdAt: new Date('2026-11-09T08:30:00Z'),
    });
    expect(
      planReminder('not_booked', e, WINDOW, {
        billingEnabled: true,
        timeZone: TZ,
        organizationSettings: {},
        now: WEEK_BEFORE,
      }).skip,
    ).toBe('not_eligible');
  });

  it('Schalter der Organisation: ausgeschaltete Mails fallen weg, Rest bleibt', () => {
    const off = { eventReminders: { weekBefore: false } };
    expect(kinds(event(), WEEK_BEFORE, true, off)).toEqual([]);
    expect(kinds(event(), DAY_BEFORE, true, off)).toEqual(['day_before']);
    const notBookedOff = { eventReminders: { notBooked: false } };
    expect(
      kinds(
        event({ status: 'test', billingStatus: 'none' }),
        WEEK_BEFORE,
        true,
        notBookedOff,
      ),
    ).toEqual([]);
  });
});

describe('Einstellungen', () => {
  it('normalizeEventReminderSettings behaelt nur bekannte Wahrheitswerte', () => {
    expect(
      normalizeEventReminderSettings({
        weekBefore: false,
        dayBefore: 'nein',
        afterEvent: true,
        other: false,
      }),
    ).toEqual({ weekBefore: false, afterEvent: true });
    expect(normalizeEventReminderSettings(null)).toEqual({});
  });

  it('isReminderEnabled: Standard an', () => {
    expect(isReminderEnabled({}, 'week_before')).toBe(true);
    expect(isReminderEnabled(null, 'after_event')).toBe(true);
    expect(
      isReminderEnabled(
        { eventReminders: { afterEvent: false } },
        'after_event',
      ),
    ).toBe(false);
  });

  it('userWantsEventReminders: E-Mail aus oder Erinnerungen aus → nein', () => {
    expect(userWantsEventReminders(null)).toBe(true);
    expect(
      userWantsEventReminders({ notifications: { email: true, push: false } }),
    ).toBe(true);
    expect(userWantsEventReminders({ notifications: { email: false } })).toBe(
      false,
    );
    expect(
      userWantsEventReminders({ notifications: { eventReminders: false } }),
    ).toBe(false);
  });
});
