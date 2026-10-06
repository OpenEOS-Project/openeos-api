import { endOfDay, localDateKey, startOfDay } from './date-range.util';

/** Fuehrt fn in der angegebenen Zeitzone aus; Node uebernimmt TZ sofort. */
function inTimeZone<T>(timeZone: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

describe('date-range.util', () => {
  describe('in Europe/Berlin (production image)', () => {
    it('starts a plain day at local midnight, not at 02:00', () => {
      inTimeZone('Europe/Berlin', () => {
        // new Date('2026-09-12') would be 02:00 in Berlin.
        expect(startOfDay('2026-09-12').toISOString()).toBe(
          '2026-09-11T22:00:00.000Z',
        );
      });
    });

    it('ends a plain day at local 23:59:59.999', () => {
      inTimeZone('Europe/Berlin', () => {
        expect(endOfDay('2026-09-12').toISOString()).toBe(
          '2026-09-12T21:59:59.999Z',
        );
      });
    });

    it('handles the winter time offset', () => {
      inTimeZone('Europe/Berlin', () => {
        expect(startOfDay('2026-12-24').toISOString()).toBe(
          '2026-12-23T23:00:00.000Z',
        );
      });
    });

    it('takes the local calendar day of an instant', () => {
      inTimeZone('Europe/Berlin', () => {
        // 00:30 in Berlin, still the previous day in UTC.
        expect(localDateKey(new Date('2026-09-11T22:30:00.000Z'))).toBe(
          '2026-09-12',
        );
      });
    });
  });

  describe.each(['UTC', 'America/New_York', 'Pacific/Auckland'])(
    'in %s',
    (timeZone) => {
      it('keeps the calendar day of a plain date', () => {
        inTimeZone(timeZone, () => {
          const start = startOfDay('2026-09-12');
          const end = endOfDay('2026-09-12');
          expect(localDateKey(start)).toBe('2026-09-12');
          expect(localDateKey(end)).toBe('2026-09-12');
          expect([start.getHours(), start.getMinutes()]).toEqual([0, 0]);
          expect([end.getHours(), end.getMinutes()]).toEqual([23, 59]);
        });
      });
    },
  );

  it('leaves values with a time and Date objects alone', () => {
    const date = new Date('2026-09-12T10:00:00.000Z');
    expect(startOfDay(date)).toBe(date);
    expect(endOfDay(date)).toBe(date);
    expect(endOfDay('2026-09-12T10:00:00.000Z').toISOString()).toBe(
      '2026-09-12T10:00:00.000Z',
    );
  });
});
