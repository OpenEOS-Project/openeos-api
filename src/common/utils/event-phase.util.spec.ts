import {
  DEFAULT_EVENT_PHASE_SETTINGS,
  EventPhaseEvent,
  EventPhaseSettings,
  orderModeFor,
  resolveEventPhase,
  salesWindow,
} from './event-phase.util';
import { countBillableDays, eventBusinessSpan } from './event-schedule.util';

const TZ = 'Europe/Berlin';
const settings: EventPhaseSettings = { ...DEFAULT_EVENT_PHASE_SETTINGS };

/** Mitternacht Berlin eines Kalendertags als UTC-Zeitpunkt. */
function midnight(day: string): Date {
  const offsetAt = (date: Date): number =>
    Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: TZ,
        timeZoneName: 'shortOffset',
      })
        .formatToParts(date)
        .find((p) => p.type === 'timeZoneName')
        ?.value.replace('GMT', '') || '0',
    );
  const utcMidnight = new Date(`${day}T00:00:00Z`);
  // Der Versatz um Mitternacht UTC ist an den Umstellungstagen (Umstellung
  // um 1 Uhr UTC) noch der des Vortags — genau der von Mitternacht Berlin.
  return new Date(utcMidnight.getTime() - offsetAt(utcMidnight) * 3600_000);
}

function paidEvent(
  start: string,
  end: string,
  extra: Partial<EventPhaseEvent> = {},
): EventPhaseEvent {
  return {
    status: 'active',
    billingStatus: 'paid',
    startDate: midnight(start),
    endDate: midnight(end),
    settings: {},
    ...extra,
  };
}

const at = (iso: string) => new Date(iso);

describe('salesWindow / resolveEventPhase — date-only event 16.–17.11.', () => {
  const event = paidEvent('2026-11-16', '2026-11-17');

  it('starts real sales 12 h before the first business day (15.11. 18:00)', () => {
    const info = resolveEventPhase(
      event,
      { timezone: TZ },
      settings,
      at('2026-11-08T12:00:00Z'),
    );
    expect(info.realSalesFrom).toBe('2026-11-15T17:00:00.000Z'); // 18:00 MEZ
    expect(info.businessDaysFrom).toBe('2026-11-16T05:00:00.000Z'); // 06:00
    expect(info.businessDaysUntil).toBe('2026-11-18T05:00:00.000Z'); // 18.11. 06:00
    expect(info.realSalesUntil).toBe('2026-11-18T11:00:00.000Z'); // + 6 h Kulanz
    expect(info.phase).toBe('planned');
    expect(info.datesLocked).toBe(false);
  });

  it.each([
    ['2026-11-15T16:59:59Z', 'planned'],
    ['2026-11-15T17:00:00Z', 'active'],
    ['2026-11-17T22:00:00Z', 'active'],
    ['2026-11-18T10:59:59Z', 'active'],
    ['2026-11-18T11:00:00Z', 'ended'],
  ])('at %s the phase is %s', (now, phase) => {
    expect(
      resolveEventPhase(event, { timezone: TZ }, settings, at(now)).phase,
    ).toBe(phase);
  });

  it('locks the dates once the window has begun (with billing)', () => {
    expect(
      resolveEventPhase(
        event,
        { timezone: TZ },
        settings,
        at('2026-11-15T17:00:00Z'),
      ).datesLocked,
    ).toBe(true);
    expect(
      resolveEventPhase(
        event,
        { timezone: TZ },
        settings,
        at('2026-11-20T00:00:00Z'),
      ).datesLocked,
    ).toBe(true);
  });

  it('keeps status phases: inactive and test ignore the dates', () => {
    const now = at('2026-11-16T12:00:00Z');
    expect(
      resolveEventPhase(
        { ...event, status: 'inactive' },
        { timezone: TZ },
        settings,
        now,
      ).phase,
    ).toBe('inactive');
    expect(
      resolveEventPhase(
        { ...event, status: 'test' },
        { timezone: TZ },
        settings,
        now,
      ).phase,
    ).toBe('test');
  });
});

describe('who gets date phases', () => {
  const now = at('2026-11-08T12:00:00Z');

  it('legacy active event without unlock (billing on) stays active, no window', () => {
    const info = resolveEventPhase(
      paidEvent('2026-11-16', '2026-11-17', { billingStatus: 'none' }),
      { timezone: TZ },
      settings,
      now,
    );
    expect(info.phase).toBe('active');
    expect(info.datePhases).toBe(false);
    expect(info.realSalesFrom).toBeNull();
  });

  it.each(['paid', 'invoice', 'waived'])(
    'unlocked (%s) events use the phases',
    (billingStatus) => {
      expect(
        resolveEventPhase(
          paidEvent('2026-11-16', '2026-11-17', { billingStatus }),
          { timezone: TZ },
          settings,
          now,
        ).phase,
      ).toBe('planned');
    },
  );

  it('self-hosted: phases without billing, dates never locked', () => {
    const selfHosted = { ...settings, billingEnabled: false };
    const event = paidEvent('2026-11-16', '2026-11-17', {
      billingStatus: 'none',
    });
    expect(
      resolveEventPhase(event, { timezone: TZ }, selfHosted, now).phase,
    ).toBe('planned');
    const later = resolveEventPhase(
      event,
      { timezone: TZ },
      selfHosted,
      at('2026-11-19T00:00:00Z'),
    );
    expect(later.phase).toBe('ended');
    expect(later.datesLocked).toBe(false);
  });

  it('EVENT_DATE_PHASES=false: only the status counts', () => {
    const off = { ...settings, enabled: false };
    const info = resolveEventPhase(
      paidEvent('2026-11-16', '2026-11-17'),
      { timezone: TZ },
      off,
      now,
    );
    expect(info.phase).toBe('active');
    expect(info.datesLocked).toBe(false);
  });

  it('no start date: stays active', () => {
    expect(
      resolveEventPhase(
        { ...paidEvent('2026-11-16', '2026-11-17'), startDate: null },
        { timezone: TZ },
        settings,
        now,
      ).phase,
    ).toBe('active');
  });
});

describe('early start and grace settings', () => {
  const now = at('2026-11-08T12:00:00Z');
  const withLead = (earlyStartHours: unknown) =>
    paidEvent('2026-11-16', '2026-11-17', {
      settings: { sales: { earlyStartHours } },
    });

  it.each([
    [24, '2026-11-15T05:00:00.000Z'],
    [0, '2026-11-16T05:00:00.000Z'],
    [6, '2026-11-15T23:00:00.000Z'],
    [99, '2026-11-15T05:00:00.000Z'], // auf das Maximum (24) gekappt
    ['abc', '2026-11-15T17:00:00.000Z'], // unlesbar: Standard
  ])('per event %p h → %s', (hours, expected) => {
    expect(
      resolveEventPhase(withLead(hours), { timezone: TZ }, settings, now)
        .realSalesFrom,
    ).toBe(expected);
  });

  it('grace comes from the configuration', () => {
    const info = resolveEventPhase(
      paidEvent('2026-11-16', '2026-11-17'),
      { timezone: TZ },
      { ...settings, graceHours: 0 },
      now,
    );
    expect(info.realSalesUntil).toBe('2026-11-18T05:00:00.000Z');
  });

  it('timed event (16.11. 18:00 – 17.11. 02:00): one business day', () => {
    const info = resolveEventPhase(
      {
        ...paidEvent('2026-11-16', '2026-11-17'),
        startDate: at('2026-11-16T17:00:00Z'),
        endDate: at('2026-11-17T01:00:00Z'),
      },
      { timezone: TZ },
      settings,
      now,
    );
    expect(info.businessDaysFrom).toBe('2026-11-16T05:00:00.000Z');
    expect(info.businessDaysUntil).toBe('2026-11-17T05:00:00.000Z');
    expect(info.realSalesFrom).toBe('2026-11-15T17:00:00.000Z');
    expect(info.realSalesUntil).toBe('2026-11-17T11:00:00.000Z');
  });
});

describe('daylight saving time', () => {
  it('end of DST (25.10.2026): 18:00 the evening before, 13 real hours ahead', () => {
    const window = salesWindow(
      paidEvent('2026-10-25', '2026-10-25'),
      { timezone: TZ },
      settings,
    )!;
    expect(window.businessDaysFrom.toISOString()).toBe(
      '2026-10-25T05:00:00.000Z',
    ); // 06:00 MEZ
    expect(window.realSalesFrom.toISOString()).toBe('2026-10-24T16:00:00.000Z'); // 18:00 MESZ
  });

  it('start of DST (29.03.2026): 18:00 the evening before, 11 real hours ahead', () => {
    const window = salesWindow(
      paidEvent('2026-03-29', '2026-03-29'),
      { timezone: TZ },
      settings,
    )!;
    expect(window.businessDaysFrom.toISOString()).toBe(
      '2026-03-29T04:00:00.000Z',
    ); // 06:00 MESZ
    expect(window.realSalesFrom.toISOString()).toBe('2026-03-28T17:00:00.000Z'); // 18:00 MEZ
  });

  it('grace across the DST night ends at 12:00 wall clock', () => {
    const window = salesWindow(
      paidEvent('2026-10-24', '2026-10-24'),
      { timezone: TZ },
      settings,
    )!;
    expect(window.businessDaysUntil.toISOString()).toBe(
      '2026-10-25T05:00:00.000Z',
    ); // 06:00 MEZ
    expect(window.realSalesUntil.toISOString()).toBe(
      '2026-10-25T11:00:00.000Z',
    ); // 12:00 MEZ
  });
});

describe('month boundary and Cloud-TSE', () => {
  const event = paidEvent('2026-12-01', '2026-12-02');

  it('without Cloud-TSE the evening before may lie in the previous month', () => {
    const window = salesWindow(
      event,
      { timezone: TZ, usesCloudTse: false },
      settings,
    )!;
    expect(window.realSalesFrom.toISOString()).toBe('2026-11-30T17:00:00.000Z'); // 30.11. 18:00
    expect(window.earlyStartLimitedByMonth).toBe(false);
  });

  it('with Cloud-TSE real sales start at 0:00 on the 1st', () => {
    const window = salesWindow(
      event,
      { timezone: TZ, usesCloudTse: true },
      settings,
    )!;
    expect(window.realSalesFrom.toISOString()).toBe('2026-11-30T23:00:00.000Z'); // 01.12. 00:00
    expect(window.earlyStartLimitedByMonth).toBe(true);
    const info = resolveEventPhase(
      event,
      { timezone: TZ, usesCloudTse: true },
      settings,
      at('2026-11-30T20:00:00Z'),
    );
    expect(info.phase).toBe('planned');
    expect(info.earlyStartLimitedByMonth).toBe(true);
  });

  it('with Cloud-TSE inside the month nothing is cut', () => {
    const window = salesWindow(
      paidEvent('2026-12-02', '2026-12-02'),
      { timezone: TZ, usesCloudTse: true },
      settings,
    )!;
    expect(window.realSalesFrom.toISOString()).toBe('2026-12-01T17:00:00.000Z');
    expect(window.earlyStartLimitedByMonth).toBe(false);
  });

  it('an explicit night start on the 1st (02:00) belongs to the 31st — no cut', () => {
    const window = salesWindow(
      {
        ...event,
        startDate: at('2026-12-01T01:00:00Z'),
        endDate: at('2026-12-01T03:00:00Z'),
      },
      { timezone: TZ, usesCloudTse: true },
      settings,
    )!;
    expect(window.businessDaysFrom.toISOString()).toBe(
      '2026-11-30T05:00:00.000Z',
    );
    expect(window.realSalesFrom.toISOString()).toBe('2026-11-29T17:00:00.000Z');
  });
});

describe('orderModeFor', () => {
  it.each([
    ['inactive', false, 'pos', 'reject'],
    ['ended', false, 'pos', 'reject'],
    ['ended', true, 'shop', 'reject'],
    ['test', false, 'shop', 'test'],
    ['planned', false, 'pos', 'test'],
    ['planned', false, 'table', 'test'],
    ['planned', false, 'qr', 'test'],
    ['planned', true, 'pos', 'test'],
    ['planned', false, 'shop', 'reject'],
    ['planned', true, 'shop', 'real'],
    ['active', false, 'shop', 'real'],
    ['active', false, 'pos', 'real'],
  ] as const)(
    '%s (presale %s) via %s → %s',
    (phase, presaleEnabled, channel, expected) => {
      expect(orderModeFor({ phase, presaleEnabled }, channel)).toBe(expected);
    },
  );
});

describe('eventBusinessSpan agrees with countBillableDays', () => {
  const cases: [string, string][] = [
    ['2026-11-16T00:00:00+01:00', '2026-11-17T00:00:00+01:00'],
    ['2026-11-16T00:00:00+01:00', '2026-11-16T00:00:00+01:00'],
    ['2026-11-16T18:00:00+01:00', '2026-11-17T02:00:00+01:00'],
    ['2026-11-16T00:00:00+01:00', '2026-11-17T02:00:00+01:00'],
    ['2026-11-14T17:00:00+01:00', '2026-11-16T18:00:00+01:00'],
    ['2026-10-23T00:00:00+02:00', '2026-10-26T00:00:00+01:00'],
    ['2026-11-16T06:00:00+01:00', '2026-11-17T06:00:00+01:00'],
  ];
  it.each(cases)('%s – %s', (start, end) => {
    const span = eventBusinessSpan(new Date(start), new Date(end), TZ, 6)!;
    expect(span.days).toBe(
      countBillableDays(new Date(start), new Date(end), TZ, 6),
    );
  });

  it('date-only days are the calendar days themselves', () => {
    const span = eventBusinessSpan(
      midnight('2026-11-16'),
      midnight('2026-11-17'),
      TZ,
    )!;
    expect(span.from.toISOString()).toBe('2026-11-16T05:00:00.000Z');
    expect(span.to.toISOString()).toBe('2026-11-18T05:00:00.000Z');
  });
});
