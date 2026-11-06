import { berlinTime } from './tse-dates';
import {
  backoffMs,
  blockingEvents,
  businessDayStart,
  currentKeep,
  deactivationOutlook,
  eventsInMonth,
  isDeactivationOverdue,
  localMonthRange,
  monthKey,
  monthlyPhase,
  nextMonthEvents,
  plannedDeactivationFor,
  postponedDeactivation,
} from './tse-monthly';
import { parseTseLifecycle, tseSettingsFromEnv } from './tse.config';

const event = (
  id: string,
  start: Date,
  end: Date | null = null,
): { id: string; name: string; startDate: Date; endDate: Date | null } => ({
  id,
  name: id,
  startDate: start,
  endDate: end,
});

describe('TSE_LIFECYCLE', () => {
  it('defaults to monthly and maps the old per_event to monthly', () => {
    expect(parseTseLifecycle('')).toBe('monthly');
    expect(parseTseLifecycle('monthly')).toBe('monthly');
    expect(parseTseLifecycle('per_event')).toBe('monthly');
    expect(parseTseLifecycle('persistent')).toBe('persistent');
    expect(parseTseLifecycle(' Persistent ')).toBe('persistent');
    expect(tseSettingsFromEnv({}).lifecycle).toBe('monthly');
    expect(tseSettingsFromEnv({ TSE_LIFECYCLE: 'per_event' }).lifecycle).toBe(
      'monthly',
    );
  });
});

describe('planned deactivation (last day of the month, 20:00 Berlin)', () => {
  it('uses the last day of the Berlin month at 20:00 (winter time = 19:00 UTC)', () => {
    const planned = plannedDeactivationFor(berlinTime(2026, 11, 14, 18));
    expect(planned.toISOString()).toBe('2026-11-30T19:00:00.000Z');
  });

  it('uses summer time in summer months (20:00 CEST = 18:00 UTC)', () => {
    expect(
      plannedDeactivationFor(berlinTime(2026, 7, 18, 12)).toISOString(),
    ).toBe('2026-07-31T18:00:00.000Z');
  });

  it('handles the DST change at the end of March (last Sunday) and October', () => {
    // 2026-03-29 is the switch to summer time; March 31 is CEST.
    expect(
      plannedDeactivationFor(berlinTime(2026, 3, 2, 10)).toISOString(),
    ).toBe('2026-03-31T18:00:00.000Z');
    // 2026-10-25 back to winter time; October 31 is CET.
    expect(
      plannedDeactivationFor(berlinTime(2026, 10, 3, 10)).toISOString(),
    ).toBe('2026-10-31T19:00:00.000Z');
    // A month whose last day IS the switch day: 2027-10-31 (Sunday).
    expect(
      plannedDeactivationFor(berlinTime(2027, 10, 5, 10)).toISOString(),
    ).toBe('2027-10-31T19:00:00.000Z');
  });

  it('uses the Berlin month, not the UTC month, around midnight', () => {
    // 1 Dec 00:30 Berlin = 30 Nov 23:30 UTC → December.
    const justAfterMidnight = berlinTime(2026, 12, 1, 0, 30);
    expect(justAfterMidnight.toISOString()).toBe('2026-11-30T23:30:00.000Z');
    expect(plannedDeactivationFor(justAfterMidnight).toISOString()).toBe(
      '2026-12-31T19:00:00.000Z',
    );
    expect(monthKey(justAfterMidnight)).toBe('2026-12');
  });

  it('always lies before the month boundary in UTC as well', () => {
    for (let month = 1; month <= 12; month++) {
      const planned = plannedDeactivationFor(berlinTime(2026, month, 10, 12));
      const utcEnd = Date.UTC(2026, month, 1); // first day of next month 00:00 UTC
      expect(utcEnd - planned.getTime()).toBeGreaterThanOrEqual(4 * 3600_000);
    }
  });

  it('handles February in leap and non-leap years', () => {
    expect(
      plannedDeactivationFor(berlinTime(2027, 2, 3, 12)).toISOString(),
    ).toBe('2027-02-28T19:00:00.000Z');
    expect(
      plannedDeactivationFor(berlinTime(2028, 2, 3, 12)).toISOString(),
    ).toBe('2028-02-29T19:00:00.000Z');
  });

  it('postpones to the end of the following month (also across the year)', () => {
    expect(
      postponedDeactivation(berlinTime(2026, 11, 30, 20)).toISOString(),
    ).toBe('2026-12-31T19:00:00.000Z');
    expect(
      postponedDeactivation(berlinTime(2026, 12, 31, 20)).toISOString(),
    ).toBe('2027-01-31T19:00:00.000Z');
    // Ueberfaellig im neuen Monat (Monat ist ohnehin berechnet): dessen Ende.
    expect(
      postponedDeactivation(berlinTime(2026, 12, 1, 2)).toISOString(),
    ).toBe('2026-12-31T19:00:00.000Z');
  });
});

describe('phases and overdue', () => {
  const planned = berlinTime(2026, 11, 30, 20);
  it('prepares from 18:00, deactivates from 20:00, is overdue from 22:00', () => {
    expect(monthlyPhase(planned, berlinTime(2026, 11, 30, 17, 45))).toBe(
      'idle',
    );
    expect(monthlyPhase(planned, berlinTime(2026, 11, 30, 18))).toBe('prepare');
    expect(monthlyPhase(planned, berlinTime(2026, 11, 30, 19, 45))).toBe(
      'prepare',
    );
    expect(monthlyPhase(planned, berlinTime(2026, 11, 30, 20))).toBe(
      'deactivate',
    );
    expect(monthlyPhase(null, berlinTime(2026, 11, 30, 20))).toBe('idle');
    expect(
      isDeactivationOverdue(planned, berlinTime(2026, 11, 30, 21, 59)),
    ).toBe(false);
    expect(isDeactivationOverdue(planned, berlinTime(2026, 11, 30, 22))).toBe(
      true,
    );
  });

  it('backs off 5, 10, 15, 30, then 60 minutes', () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => backoffMs(n) / 60_000)).toEqual([
      5, 10, 15, 30, 60, 60,
    ]);
  });
});

describe('business days and blocking events', () => {
  const T = berlinTime(2026, 11, 30, 20); // geplante Abmeldung

  it('business day starts at 06:00; before 06:00 it is still the previous day', () => {
    expect(businessDayStart(berlinTime(2026, 11, 30, 5, 59))).toEqual(
      berlinTime(2026, 11, 29, 6),
    );
    expect(businessDayStart(berlinTime(2026, 11, 30, 6))).toEqual(
      berlinTime(2026, 11, 30, 6),
    );
  });

  it('an event mid-month does not block the month-end deactivation', () => {
    const mid = event(
      'mid',
      berlinTime(2026, 11, 14, 14),
      berlinTime(2026, 11, 15, 2),
    );
    expect(blockingEvents([mid], T)).toEqual([]);
  });

  it('an event on the last day running past midnight blocks', () => {
    const last = event(
      'last',
      berlinTime(2026, 11, 30, 18),
      berlinTime(2026, 12, 1, 2),
    );
    expect(blockingEvents([last], T).map((e) => e.id)).toEqual(['last']);
  });

  it('an event that ends on the last day before 20:00 still blocks (its business day runs until 06:00)', () => {
    const afternoon = event(
      'afternoon',
      berlinTime(2026, 11, 30, 11),
      berlinTime(2026, 11, 30, 17),
    );
    expect(blockingEvents([afternoon], T)).toHaveLength(1);
  });

  it('an event starting later on the last day (or after midnight before 06:00) blocks', () => {
    expect(
      blockingEvents([event('late', berlinTime(2026, 11, 30, 22))], T),
    ).toHaveLength(1);
    expect(
      blockingEvents([event('night', berlinTime(2026, 12, 1, 3))], T),
    ).toHaveLength(1);
  });

  it('an event starting on the 1st after 06:00 does not block', () => {
    expect(
      blockingEvents([event('next', berlinTime(2026, 12, 1, 10))], T),
    ).toEqual([]);
  });

  it('an event spanning the month boundary blocks', () => {
    const span = event(
      'span',
      berlinTime(2026, 11, 28, 10),
      berlinTime(2026, 12, 3, 23),
    );
    expect(blockingEvents([span], T)).toHaveLength(1);
  });

  it('an event that ended the day before (business day over at 06:00) does not block', () => {
    const before = event(
      'before',
      berlinTime(2026, 11, 29, 18),
      berlinTime(2026, 11, 30, 3),
    );
    expect(blockingEvents([before], T)).toEqual([]);
  });

  it('counts events touching the month for the health check', () => {
    const now = berlinTime(2026, 12, 10, 7);
    expect(localMonthRange(now).from).toEqual(berlinTime(2026, 12, 1));
    expect(localMonthRange(now).to).toEqual(berlinTime(2027, 1, 1));
    const nov = event(
      'nov',
      berlinTime(2026, 11, 14, 14),
      berlinTime(2026, 11, 15, 2),
    );
    const spill = event(
      'spill',
      berlinTime(2026, 11, 30, 18),
      berlinTime(2026, 12, 1, 2),
    );
    const dec = event('dec', berlinTime(2026, 12, 20, 18));
    expect(eventsInMonth([nov], now)).toEqual([]);
    // Geschaeftstag des 30.11. endet am 1.12. um 06:00 → beruehrt Dezember.
    expect(eventsInMonth([spill], now).map((e) => e.id)).toEqual(['spill']);
    expect(eventsInMonth([dec], now).map((e) => e.id)).toEqual(['dec']);
  });
});

describe('next month already booked (decision 2026-11-06)', () => {
  const planned = berlinTime(2026, 11, 30, 20);

  it('counts events with a business day starting in the next month', () => {
    const dec = event(
      'dec',
      berlinTime(2026, 12, 12, 15),
      berlinTime(2026, 12, 12, 23),
    );
    const firstMorning = event(
      'first',
      berlinTime(2026, 12, 1, 7),
      berlinTime(2026, 12, 1, 12),
    );
    const crossing = event(
      'crossing',
      berlinTime(2026, 11, 29, 10),
      berlinTime(2026, 12, 2, 22),
    );
    const jan = event('jan', berlinTime(2027, 1, 9, 10));
    expect(
      nextMonthEvents([dec, firstMorning, crossing, jan], planned).map(
        (e) => e.id,
      ),
    ).toEqual(['dec', 'first', 'crossing']);
  });

  it('does not count the overhang until 06:00 on the 1st (that stays the postponement rule)', () => {
    const lastDay = event(
      'last',
      berlinTime(2026, 11, 30, 10),
      berlinTime(2026, 11, 30, 19),
    );
    const pastMidnight = event(
      'party',
      berlinTime(2026, 11, 30, 18),
      berlinTime(2026, 12, 1, 3),
    );
    const nov = event(
      'nov',
      berlinTime(2026, 11, 14, 14),
      berlinTime(2026, 11, 15, 2),
    );
    expect(nextMonthEvents([lastDay, pastMidnight, nov], planned)).toEqual([]);
  });

  it('works across the year change', () => {
    const jan = event('jan', berlinTime(2027, 1, 2, 10));
    expect(
      nextMonthEvents([jan], berlinTime(2026, 12, 31, 20)).map((e) => e.id),
    ).toEqual(['jan']);
    expect(nextMonthEvents([jan], planned)).toEqual([]);
  });

  it('outlook: chains booked months and running events until a month end has no reason', () => {
    const dec = event(
      'dec',
      berlinTime(2026, 12, 12, 15),
      berlinTime(2026, 12, 12, 23),
    );
    const newYear = event(
      'newyear',
      berlinTime(2026, 12, 31, 20),
      berlinTime(2027, 1, 1, 3),
    );
    const outlook = deactivationOutlook([dec, newYear], planned);
    expect(
      outlook.months.map((m) => [m.month, m.reason, m.events.map((e) => e.id)]),
    ).toEqual([
      ['2026-12', 'paid_event_next_month', ['dec', 'newyear']],
      ['2027-01', 'paid_event_running', ['newyear']],
    ]);
    expect(outlook.at).toEqual(berlinTime(2027, 1, 31, 20));
  });

  it('outlook: nothing booked → the planned date stays', () => {
    const nov = event(
      'nov',
      berlinTime(2026, 11, 14, 14),
      berlinTime(2026, 11, 15, 2),
    );
    expect(deactivationOutlook([nov], planned)).toEqual({
      at: planned,
      months: [],
    });
  });

  it('outlook: a month gap ends the chain (only the directly following month counts)', () => {
    const jan = event('jan', berlinTime(2027, 1, 9, 10));
    expect(deactivationOutlook([jan], planned).months).toEqual([]);
  });

  it('currentKeep: only the latest, not revoked entry that led to the current date', () => {
    const entry = {
      at: planned.toISOString(),
      from: planned.toISOString(),
      to: berlinTime(2026, 12, 31, 20).toISOString(),
      reason: 'paid_event_next_month' as const,
      month: '2026-12',
      events: [],
      recheckUntil: berlinTime(2026, 12, 1).toISOString(),
      revokedAt: null,
    };
    const unit = (plannedAt: Date, keeps: unknown[]) => ({
      plannedDeactivationAt: plannedAt,
      metadata: { keeps },
    });
    expect(currentKeep(unit(berlinTime(2026, 12, 31, 20), [entry]))).toEqual(
      entry,
    );
    expect(currentKeep(unit(planned, [entry]))).toBeNull();
    expect(
      currentKeep(
        unit(berlinTime(2026, 12, 31, 20), [{ ...entry, revokedAt: 'x' }]),
      ),
    ).toBeNull();
    expect(
      currentKeep({ plannedDeactivationAt: planned, metadata: {} }),
    ).toBeNull();
  });
});
