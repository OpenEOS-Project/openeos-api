import { Event, ShopOpeningHours } from '../../database/entities/event.entity';
import { resolveShopWindows } from './events-shop-public.controller';

/*
 * All expectations are absolute instants (ISO, UTC). The result must not
 * depend on the time zone of the machine running the tests — only on the
 * time zone passed in.
 */

function weeklyEvent(
  startDate: string,
  endDate: string,
  openingHours: ShopOpeningHours,
): Event {
  return {
    startDate: new Date(startDate),
    endDate: new Date(endDate),
    settings: { shop: { enabled: true, hoursMode: 'weekly', openingHours } },
  } as unknown as Event;
}

describe('resolveShopWindows (weekly opening hours)', () => {
  it('uses local wall-clock time across the end of daylight saving time', () => {
    // Fri 2026-10-23 to Mon 2026-10-26 in Berlin; DST ends on Sun 2026-10-25.
    const event = weeklyEvent('2026-10-23T08:00:00Z', '2026-10-26T20:00:00Z', {
      sat: { start: '10:00', end: '18:00' },
      sun: { start: '10:00', end: '18:00' },
    });

    expect(resolveShopWindows(event, 'Europe/Berlin')).toEqual([
      // Saturday, CEST (UTC+2)
      { start: '2026-10-24T08:00:00.000Z', end: '2026-10-24T16:00:00.000Z' },
      // Sunday, CET (UTC+1)
      { start: '2026-10-25T09:00:00.000Z', end: '2026-10-25T17:00:00.000Z' },
    ]);
  });

  it('uses local wall-clock time across the start of daylight saving time', () => {
    // DST starts on Sun 2026-03-29 in Berlin.
    const event = weeklyEvent('2026-03-28T08:00:00Z', '2026-03-29T20:00:00Z', {
      sat: { start: '10:00', end: '18:00' },
      sun: { start: '10:00', end: '18:00' },
    });

    expect(resolveShopWindows(event, 'Europe/Berlin')).toEqual([
      { start: '2026-03-28T09:00:00.000Z', end: '2026-03-28T17:00:00.000Z' },
      { start: '2026-03-29T08:00:00.000Z', end: '2026-03-29T16:00:00.000Z' },
    ]);
  });

  it('picks the weekday in the event time zone, not in UTC', () => {
    // 22:30 UTC on Friday is already Saturday 00:30 in Berlin, and the
    // event ends on Saturday 23:30 Berlin time — still Saturday in Berlin.
    const event = weeklyEvent('2026-10-23T22:30:00Z', '2026-10-24T21:30:00Z', {
      fri: { start: '10:00', end: '18:00' },
      sat: { start: '10:00', end: '18:00' },
    });

    expect(resolveShopWindows(event, 'Europe/Berlin')).toEqual([
      { start: '2026-10-24T08:00:00.000Z', end: '2026-10-24T16:00:00.000Z' },
    ]);
  });

  it('honours other time zones', () => {
    const event = weeklyEvent('2026-07-04T14:00:00Z', '2026-07-04T20:00:00Z', {
      sat: { start: '10:00', end: '18:00' },
    });

    expect(resolveShopWindows(event, 'America/New_York')).toEqual([
      { start: '2026-07-04T14:00:00.000Z', end: '2026-07-04T22:00:00.000Z' },
    ]);
  });

  it('still ignores entries that end before they start', () => {
    const event = weeklyEvent('2026-10-24T08:00:00Z', '2026-10-24T20:00:00Z', {
      sat: { start: '18:00', end: '02:00' },
    });

    expect(resolveShopWindows(event, 'Europe/Berlin')).toEqual([]);
  });
});
