import { DEFAULT_EVENT_PHASE_SETTINGS } from '../../common/utils/event-phase.util';
import { Event } from '../../database/entities/event.entity';
import { isTseCreationDue } from './tse-unit.service';
import { blockingEvents, businessSpan, nextMonthEvents } from './tse-monthly';

/**
 * Cloud-TSE und Phasen der Veranstaltung (2026-11-08): die Automatik legt
 * die TSE rechtzeitig vor dem Verkaufsfenster an, nie im Vormonat; die
 * Monatsabmeldung liest reine Daten als Kalendertage.
 */
const phase = { settings: DEFAULT_EVENT_PHASE_SETTINGS };
const berlin = { settings: { timezone: 'Europe/Berlin' } } as never;

function event(start: string, end: string, extra: object = {}) {
  return {
    startDate: new Date(start),
    endDate: new Date(end),
    settings: {},
    ...extra,
  } as unknown as Event;
}

describe('isTseCreationDue', () => {
  // 16.–17.11.2026, Verkaufsfenster ab 15.11. 18:00 → Anlage ab 06:00
  const festival = event('2026-11-15T23:00:00Z', '2026-11-16T23:00:00Z');

  it.each([
    ['2026-11-15T04:59:00Z', false],
    ['2026-11-15T05:00:00Z', true],
    ['2026-11-17T12:00:00Z', true],
    ['2026-11-18T10:59:00Z', true],
    ['2026-11-18T11:00:00Z', false],
  ])('16.–17.11. at %s → %s', (now, due) => {
    expect(isTseCreationDue(festival, berlin, phase, new Date(now))).toBe(due);
  });

  it('a longer own early start moves the creation earlier', () => {
    const early = event('2026-11-15T23:00:00Z', '2026-11-16T23:00:00Z', {
      settings: { sales: { earlyStartHours: 24 } },
    });
    // Fenster ab 15.11. 06:00 → Anlage ab 14.11. 18:00
    expect(
      isTseCreationDue(early, berlin, phase, new Date('2026-11-14T17:00:00Z')),
    ).toBe(true);
  });

  it('event on the 1st: never in the previous month, from midnight on', () => {
    const first = event('2026-11-30T23:00:00Z', '2026-12-01T23:00:00Z');
    expect(
      isTseCreationDue(first, berlin, phase, new Date('2026-11-30T20:00:00Z')),
    ).toBe(false); // 30.11. 21:00
    expect(
      isTseCreationDue(first, berlin, phase, new Date('2026-11-30T22:59:00Z')),
    ).toBe(false); // 30.11. 23:59
    expect(
      isTseCreationDue(first, berlin, phase, new Date('2026-11-30T23:00:00Z')),
    ).toBe(true); // 01.12. 00:00
  });
});

describe('tse-monthly businessSpan with date-only events', () => {
  it('a festival 30.–31.10. runs at the deactivation time (31.10. 20:00)', () => {
    const lastDays = {
      id: 'e',
      name: 'Kirchweih',
      startDate: new Date('2026-10-29T23:00:00Z'), // 30.10. 00:00 MEZ
      endDate: new Date('2026-10-30T23:00:00Z'), // 31.10. 00:00 MEZ
    };
    expect(businessSpan(lastDays).to.toISOString()).toBe(
      '2026-11-01T05:00:00.000Z', // 01.11. 06:00 MEZ
    );
    expect(
      blockingEvents([lastDays], new Date('2026-10-31T19:00:00Z')),
    ).toHaveLength(1);
  });

  it('a festival on the 1st is "booked next month", not running on the 31st', () => {
    const first = {
      id: 'e',
      name: 'Adventsmarkt',
      startDate: new Date('2026-11-30T23:00:00Z'),
      endDate: new Date('2026-11-30T23:00:00Z'),
    };
    const deadline = new Date('2026-11-30T19:00:00Z'); // 30.11. 20:00
    expect(blockingEvents([first], deadline)).toHaveLength(0);
    expect(nextMonthEvents([first], deadline)).toHaveLength(1);
  });

  it('explicit times keep the 6–6 business day', () => {
    const night = {
      id: 'e',
      name: 'Nacht',
      startDate: new Date('2026-11-30T21:00:00Z'), // 30.11. 22:00
      endDate: new Date('2026-12-01T02:00:00Z'), // 01.12. 03:00
    };
    expect(businessSpan(night).to.toISOString()).toBe(
      '2026-12-01T05:00:00.000Z',
    );
    expect(
      blockingEvents([night], new Date('2026-11-30T19:00:00Z')),
    ).toHaveLength(1);
  });
});
