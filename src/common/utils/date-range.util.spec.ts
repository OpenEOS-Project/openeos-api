import { endOfDay, localDateKey, startOfDay } from './date-range.util';

/**
 * Jest kann die Zeitzone im laufenden Worker nicht umstellen
 * (process.env ist dort eine Kopie). Die Tests pruefen deshalb in der Zone
 * des Prozesses — CI laeuft in UTC, das Image in Europe/Berlin — dass ein
 * reines Datum lokal auf 00:00 bzw. 23:59:59.999 desselben Tages faellt.
 * Lokal z. B. mit `TZ=Europe/Berlin npx jest date-range` gegenpruefen.
 */
describe('date-range.util', () => {
  it('starts a plain day at local midnight', () => {
    const start = startOfDay('2026-09-12');
    expect(start.getTime()).toBe(new Date(2026, 8, 12, 0, 0, 0, 0).getTime());
    expect(localDateKey(start)).toBe('2026-09-12');
  });

  it('ends a plain day at local 23:59:59.999', () => {
    const end = endOfDay('2026-09-12');
    expect(end.getTime()).toBe(
      new Date(2026, 8, 12, 23, 59, 59, 999).getTime(),
    );
    expect(localDateKey(end)).toBe('2026-09-12');
  });

  it('works across the daylight saving change', () => {
    expect(startOfDay('2026-10-25').getTime()).toBe(
      new Date(2026, 9, 25).getTime(),
    );
    expect(endOfDay('2026-03-29').getTime()).toBe(
      new Date(2026, 2, 29, 23, 59, 59, 999).getTime(),
    );
  });

  it('includes an instant shortly after local midnight', () => {
    const justAfterMidnight = new Date(2026, 8, 12, 0, 30);
    expect(justAfterMidnight >= startOfDay('2026-09-12')).toBe(true);
    expect(justAfterMidnight <= endOfDay('2026-09-12')).toBe(true);
    expect(localDateKey(justAfterMidnight)).toBe('2026-09-12');
  });

  it('leaves values with a time and Date objects alone', () => {
    const date = new Date('2026-09-12T10:00:00.000Z');
    expect(startOfDay(date)).toBe(date);
    expect(endOfDay(date)).toBe(date);
    expect(endOfDay('2026-09-12T10:00:00.000Z').toISOString()).toBe(
      '2026-09-12T10:00:00.000Z',
    );
  });
});
