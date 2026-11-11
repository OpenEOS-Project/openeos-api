import {
  DEFAULT_EVENT_PHASE_SETTINGS,
  salesWindow,
  type SalesWindow,
} from '../../common/utils/event-phase.util';
import {
  atLocalHour,
  inSendHours,
  isDue,
  nextSendStart,
  scheduleFor,
} from './event-notification-schedule';
import { cancellationDeadline } from '../events/event-unlock-cancellation.service';

const TZ = 'Europe/Berlin';

/** Fest an reinen Daten (wie aus dem Formular): Mitternacht Ortszeit. */
function windowFor(
  start: string,
  end: string,
  options: { earlyStartHours?: number; usesCloudTse?: boolean } = {},
): SalesWindow {
  const window = salesWindow(
    {
      startDate: start,
      endDate: end,
      settings:
        options.earlyStartHours === undefined
          ? {}
          : { sales: { earlyStartHours: options.earlyStartHours } },
    },
    { timezone: TZ, usesCloudTse: options.usesCloudTse ?? false },
    DEFAULT_EVENT_PHASE_SETTINGS,
  );
  if (!window) throw new Error('no window');
  return window;
}

// Herbstfest 16.–17.11.2026: Verkauf 15.11. 18:00 bis 18.11. 12:00 (MEZ)
const HERBST = windowFor(
  '2026-11-15T23:00:00.000Z',
  '2026-11-16T23:00:00.000Z',
);

describe('scheduleFor', () => {
  it('week_before: 9 Uhr sieben Tage vor dem ersten Festtag, nachholen bis 5 Tage vorher', () => {
    const s = scheduleFor('week_before', HERBST, TZ);
    expect(s.dueAt.toISOString()).toBe('2026-11-09T08:00:00.000Z');
    expect(s.validUntil.toISOString()).toBe('2026-11-11T05:00:00.000Z');
    expect(s.scheduleKey).toBe('2026-11-16');
  });

  it('not_booked: 9 Uhr zehn Tage vor dem ersten Festtag, nachholen bis 8 Tage vorher', () => {
    const s = scheduleFor('not_booked', HERBST, TZ);
    expect(s.dueAt.toISOString()).toBe('2026-11-06T08:00:00.000Z');
    expect(s.validUntil.toISOString()).toBe('2026-11-08T05:00:00.000Z');
    expect(s.scheduleKey).toBe('2026-11-16');
  });

  it('not_booked: auch nachgeholt noch vor Ablauf der kostenlosen Stornofrist', () => {
    const deadline = cancellationDeadline(
      { startDate: new Date('2026-11-15T23:00:00.000Z') },
      TZ,
    );
    expect(deadline?.toISOString()).toBe('2026-11-08T23:00:00.000Z');
    const s = scheduleFor('not_booked', HERBST, TZ);
    expect(s.validUntil.getTime()).toBeLessThan(deadline!.getTime());
  });

  it('day_before: Verkaufsstart am Abend → 9 Uhr am selben Tag, gueltig bis Verkaufsstart', () => {
    const s = scheduleFor('day_before', HERBST, TZ);
    expect(HERBST.realSalesFrom.toISOString()).toBe('2026-11-15T17:00:00.000Z');
    expect(s.dueAt.toISOString()).toBe('2026-11-15T08:00:00.000Z');
    expect(s.validUntil.toISOString()).toBe('2026-11-15T17:00:00.000Z');
    expect(s.scheduleKey).toBe('2026-11-16');
  });

  it('day_before: Verkaufsstart am Morgen (24 h Vorlauf) → 9 Uhr am Vortag', () => {
    const w = windowFor(
      '2026-11-15T23:00:00.000Z',
      '2026-11-16T23:00:00.000Z',
      {
        earlyStartHours: 24,
      },
    );
    expect(w.realSalesFrom.toISOString()).toBe('2026-11-15T05:00:00.000Z');
    const s = scheduleFor('day_before', w, TZ);
    expect(s.dueAt.toISOString()).toBe('2026-11-14T08:00:00.000Z');
  });

  it('day_before: Cloud-TSE am Monatsersten → Verkauf ab 0 Uhr, Mail am Monatsletzten', () => {
    const w = windowFor(
      '2026-11-30T23:00:00.000Z',
      '2026-12-01T23:00:00.000Z',
      {
        usesCloudTse: true,
      },
    );
    expect(w.realSalesFrom.toISOString()).toBe('2026-11-30T23:00:00.000Z');
    const s = scheduleFor('day_before', w, TZ);
    expect(s.dueAt.toISOString()).toBe('2026-11-30T08:00:00.000Z');
  });

  it('after_event: Ende 12 Uhr → Rueckblick um 12 Uhr, bis 7 Tage danach', () => {
    const s = scheduleFor('after_event', HERBST, TZ);
    expect(HERBST.realSalesUntil.toISOString()).toBe(
      '2026-11-18T11:00:00.000Z',
    );
    expect(s.dueAt.toISOString()).toBe('2026-11-18T11:00:00.000Z');
    expect(s.validUntil.toISOString()).toBe('2026-11-25T11:00:00.000Z');
    expect(s.scheduleKey).toBe('2026-11-17');
  });

  it('after_event: Ende vor 9 Uhr → 9 Uhr; Ende nach 20 Uhr → naechster Morgen', () => {
    const early = scheduleFor(
      'after_event',
      { ...HERBST, realSalesUntil: new Date('2026-11-18T05:00:00.000Z') },
      TZ,
    );
    expect(early.dueAt.toISOString()).toBe('2026-11-18T08:00:00.000Z');
    const late = scheduleFor(
      'after_event',
      { ...HERBST, realSalesUntil: new Date('2026-11-18T21:30:00.000Z') },
      TZ,
    );
    expect(late.dueAt.toISOString()).toBe('2026-11-19T08:00:00.000Z');
  });

  it('Zeitumstellung Fruehjahr: 9 Uhr bleibt 9 Uhr Ortszeit', () => {
    // Fest am 1.4.2026 (Sommerzeit), Woche vorher 25.3. noch Winterzeit
    const w = windowFor('2026-03-31T22:00:00.000Z', '2026-03-31T22:00:00.000Z');
    const s = scheduleFor('week_before', w, TZ);
    expect(s.dueAt.toISOString()).toBe('2026-03-25T08:00:00.000Z');
    expect(w.businessDaysFrom.toISOString()).toBe('2026-04-01T04:00:00.000Z');
  });

  it('Zeitumstellung Herbst: Vortag-Mail am Tag der Umstellung um 9 Uhr MEZ', () => {
    // Fest am 26.10.2026; am 25.10. endet die Sommerzeit
    const w = windowFor('2026-10-25T23:00:00.000Z', '2026-10-25T23:00:00.000Z');
    expect(w.realSalesFrom.toISOString()).toBe('2026-10-25T17:00:00.000Z');
    const s = scheduleFor('day_before', w, TZ);
    expect(s.dueAt.toISOString()).toBe('2026-10-25T08:00:00.000Z');
    const week = scheduleFor('week_before', w, TZ);
    expect(week.dueAt.toISOString()).toBe('2026-10-19T07:00:00.000Z');
  });

  it('Schluessel folgt dem Festtag: Verschieben aendert ihn, andere Uhrzeit nicht', () => {
    const moved = windowFor(
      '2026-11-22T23:00:00.000Z',
      '2026-11-23T23:00:00.000Z',
    );
    expect(scheduleFor('week_before', moved, TZ).scheduleKey).toBe(
      '2026-11-23',
    );
    const later = windowFor(
      '2026-11-16T17:00:00.000Z',
      '2026-11-16T22:00:00.000Z',
    );
    expect(scheduleFor('week_before', later, TZ).scheduleKey).toBe(
      '2026-11-16',
    );
  });
});

describe('isDue', () => {
  const week = scheduleFor('week_before', HERBST, TZ);

  it('vor dem Termin nicht, ab 9 Uhr ja', () => {
    expect(isDue(week, new Date('2026-11-09T07:59:00Z'), TZ)).toBe(false);
    expect(isDue(week, new Date('2026-11-09T08:20:00Z'), TZ)).toBe(true);
  });

  it('nachholen bis 5 Tage vorher, danach nie mehr', () => {
    expect(isDue(week, new Date('2026-11-10T15:00:00Z'), TZ)).toBe(true);
    expect(isDue(week, new Date('2026-11-11T04:59:00Z'), TZ)).toBe(false); // Ruhezeit
    expect(isDue(week, new Date('2026-11-11T08:00:00Z'), TZ)).toBe(false);
    expect(isDue(week, new Date('2026-11-14T08:00:00Z'), TZ)).toBe(false);
  });

  it('noch nicht freigeschaltet: ab 9 Uhr zehn Tage vorher, nachholen bis 8 Tage vorher', () => {
    const notBooked = scheduleFor('not_booked', HERBST, TZ);
    expect(isDue(notBooked, new Date('2026-11-06T07:59:00Z'), TZ)).toBe(false);
    expect(isDue(notBooked, new Date('2026-11-06T08:20:00Z'), TZ)).toBe(true);
    expect(isDue(notBooked, new Date('2026-11-07T15:00:00Z'), TZ)).toBe(true);
    expect(isDue(notBooked, new Date('2026-11-08T08:00:00Z'), TZ)).toBe(false);
    expect(isDue(notBooked, new Date('2026-11-09T08:20:00Z'), TZ)).toBe(false);
  });

  it('nachts nicht — ausser die Mail waere bis 7 Uhr veraltet', () => {
    const day = scheduleFor('day_before', HERBST, TZ);
    expect(isDue(week, new Date('2026-11-09T22:30:00Z'), TZ)).toBe(false);
    // Vortag-Mail mit Verkaufsstart um 1 Uhr nachts: um 23 Uhr noch raus
    const night = {
      ...day,
      dueAt: new Date('2026-11-15T08:00:00Z'),
      validUntil: new Date('2026-11-16T00:00:00Z'),
    };
    expect(isDue(night, new Date('2026-11-15T22:10:00Z'), TZ)).toBe(true);
  });

  it('Vortag-Mail: bis zum Verkaufsstart, danach nicht mehr', () => {
    const day = scheduleFor('day_before', HERBST, TZ);
    expect(isDue(day, new Date('2026-11-15T16:59:00Z'), TZ)).toBe(true);
    expect(isDue(day, new Date('2026-11-15T17:00:00Z'), TZ)).toBe(false);
  });

  it('Rueckblick: bis 7 Tage nach dem Ende', () => {
    const after = scheduleFor('after_event', HERBST, TZ);
    expect(isDue(after, new Date('2026-11-18T10:59:00Z'), TZ)).toBe(false);
    expect(isDue(after, new Date('2026-11-24T09:00:00Z'), TZ)).toBe(true);
    expect(isDue(after, new Date('2026-11-25T12:00:00Z'), TZ)).toBe(false);
  });
});

describe('Hilfen', () => {
  it('atLocalHour, inSendHours und nextSendStart in Ortszeit', () => {
    expect(
      atLocalHour(new Date('2026-07-01T23:30:00Z'), 9, TZ).toISOString(),
    ).toBe('2026-07-02T07:00:00.000Z');
    expect(inSendHours(new Date('2026-11-09T05:59:00Z'), TZ)).toBe(false);
    expect(inSendHours(new Date('2026-11-09T06:00:00Z'), TZ)).toBe(true);
    expect(inSendHours(new Date('2026-11-09T20:00:00Z'), TZ)).toBe(false);
    expect(
      nextSendStart(new Date('2026-11-09T21:00:00Z'), TZ).toISOString(),
    ).toBe('2026-11-10T06:00:00.000Z');
    expect(
      nextSendStart(new Date('2026-11-09T02:00:00Z'), TZ).toISOString(),
    ).toBe('2026-11-09T06:00:00.000Z');
  });
});
