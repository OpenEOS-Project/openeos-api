import { Event } from '../../database/entities/event.entity';
import {
  DEFAULT_EVENT_PHASE_SETTINGS,
  resolveEventPhase,
} from '../../common/utils/event-phase.util';
import { shopAvailability } from './shop-availability';

const TZ = 'Europe/Berlin';

/** Fest 16.–17.11.2026 (reine Daten), bezahlt, Shop 16./17. je 11–22 Uhr. */
function shopEvent(
  shop: Record<string, unknown> = {},
  sales: Record<string, unknown> = {},
): Event {
  return {
    id: 'e1',
    organizationId: 'o1',
    status: 'active',
    billingStatus: 'paid',
    startDate: new Date('2026-11-15T23:00:00Z'),
    endDate: new Date('2026-11-16T23:00:00Z'),
    settings: {
      shop: {
        enabled: true,
        hoursMode: 'event',
        days: [
          { date: '2026-11-16', start: '11:00', end: '22:00' },
          { date: '2026-11-17', start: '11:00', end: '22:00' },
        ],
        ...shop,
      },
      sales,
    },
  } as unknown as Event;
}

function availability(event: Event, now: string) {
  const at = new Date(now);
  const info = resolveEventPhase(
    event,
    { timezone: TZ },
    DEFAULT_EVENT_PHASE_SETTINGS,
    at,
  );
  return shopAvailability(event, TZ, info, at);
}

describe('shopAvailability', () => {
  it('planned without presale: closed, opens with the first event window', () => {
    const result = availability(shopEvent(), '2026-11-10T12:00:00Z');
    expect(result.state).toBe('not_started');
    expect(result.isOpenNow).toBe(false);
    expect(result.nextOpening).toBe('2026-11-16T10:00:00.000Z');
  });

  it('planned with presale (event-day hours): open around the clock until the window', () => {
    const event = shopEvent({}, { presale: true });
    const night = availability(event, '2026-11-10T02:00:00Z');
    expect(night.state).toBe('presale');
    expect(night.isOpenNow).toBe(true);
    expect(night.presaleWindows).toEqual([
      { start: '2026-11-10T02:00:00.000Z', end: '2026-11-15T17:00:00.000Z' },
    ]);
  });

  it('presale ends with the sales window; then the event hours apply', () => {
    const event = shopEvent({}, { presale: true });
    // 15.11. 19:00: Verkaufsfenster laeuft, Shop-Fenster erst am 16. um 11
    const evening = availability(event, '2026-11-15T18:00:00Z');
    expect(evening.state).toBe('closed');
    expect(evening.isOpenNow).toBe(false);
    expect(evening.nextOpening).toBe('2026-11-16T10:00:00.000Z');
    expect(availability(event, '2026-11-16T12:00:00Z').state).toBe('open');
  });

  it('presale with the weekly table: the weekday hours apply on presale days', () => {
    const event = shopEvent(
      {
        hoursMode: 'weekly',
        openingHours: { tue: { start: '10:00', end: '18:00' } },
        days: undefined,
      },
      { presale: true },
    );
    // Dienstag, 10.11.2026
    expect(availability(event, '2026-11-10T12:00:00Z').state).toBe('presale');
    const closed = availability(event, '2026-11-10T20:00:00Z');
    expect(closed.state).toBe('closed');
    // Naechster Dienstag ist der 17. — ein Veranstaltungstag, die Tabelle gilt.
    expect(closed.nextOpening).toBe('2026-11-17T09:00:00.000Z');
    // Mittwoch: kein Eintrag
    expect(availability(event, '2026-11-11T12:00:00Z').isOpenNow).toBe(false);
  });

  it('ended: closed for good, even inside a configured window', () => {
    const event = shopEvent({
      days: [{ date: '2026-11-18', start: '10:00', end: '20:00' }],
    });
    const result = availability(event, '2026-11-18T12:00:00Z');
    expect(result.state).toBe('ended');
    expect(result.isOpenNow).toBe(false);
    expect(result.nextOpening).toBeNull();
  });

  it('active: windows are cut at the end of the sales window (grace)', () => {
    const event = shopEvent({
      days: [{ date: '2026-11-17', start: '10:00', end: '23:00' }],
    });
    const result = availability(event, '2026-11-17T12:00:00Z');
    expect(result.state).toBe('open');
    expect(result.windows.at(-1)?.end).toBe('2026-11-17T22:00:00.000Z');
  });

  it('test mode: always open (test orders), as before', () => {
    const event = { ...shopEvent(), status: 'test' } as Event;
    const result = availability(event, '2026-11-10T03:00:00Z');
    expect(result.state).toBe('test');
    expect(result.isOpenNow).toBe(true);
  });
});
