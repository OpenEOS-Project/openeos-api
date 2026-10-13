import { Event, ShopOpeningHours } from '../../database/entities/event.entity';
import {
  EventsShopPublicController,
  resolveShopWindows,
} from './events-shop-public.controller';

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

describe('EventsShopPublicController.getShop — legal information', () => {
  it('returns the club notices and platform links, and nothing else from the settings', async () => {
    const event = {
      id: '2ef07d24-536b-4209-9248-afa3e260e934',
      organizationId: 'org-1',
      name: 'Sommerfest',
      status: 'active',
      startDate: new Date('2026-10-24T08:00:00Z'),
      endDate: new Date('2026-10-24T20:00:00Z'),
      settings: { shop: { enabled: true } },
    };
    const organization = {
      name: 'TSV Musterstadt',
      settings: {
        currency: 'EUR',
        timezone: 'Europe/Berlin',
        sumup: { apiKey: 'sup_sk_live_secret', merchantCode: 'MC1' },
        legal: {
          imprintUrl: 'https://tsv.example/impressum',
          privacyText: 'Datenschutzhinweis',
        },
      },
    };
    const controller = new EventsShopPublicController(
      { findOne: () => Promise.resolve(event) } as never,
      { findOne: () => Promise.resolve(organization) } as never,
      undefined as never,
      undefined as never,
      {
        platformLegal: {
          imprintUrl: 'https://openeos.de/imprint',
          privacyUrl: 'https://openeos.de/privacy',
        },
      } as never,
    );

    const { data } = await controller.getShop(event.id);

    expect(data.legal).toEqual({
      organizationName: 'TSV Musterstadt',
      imprintUrl: 'https://tsv.example/impressum',
      imprintText: null,
      privacyUrl: null,
      privacyText: 'Datenschutzhinweis',
      contactEmail: null,
      complete: true,
      platform: {
        imprintUrl: 'https://openeos.de/imprint',
        privacyUrl: 'https://openeos.de/privacy',
      },
    });
    expect(JSON.stringify(data)).not.toContain('sup_sk_live_secret');
  });
});
