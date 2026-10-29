import {
  berlinDateKey,
  berlinDayStart,
  berlinNextDayStart,
} from './berlin-day.util';

describe('berlin-day.util', () => {
  it('uses the Berlin calendar day, not UTC', () => {
    // 23:30 UTC on 2026-03-01 is already 00:30 on 2026-03-02 in Berlin (CET)
    const late = new Date('2026-03-01T23:30:00Z');
    expect(berlinDateKey(late)).toBe('2026-03-02');
    expect(berlinDayStart(late).toISOString()).toBe('2026-03-01T23:00:00.000Z');
    expect(berlinNextDayStart(late).toISOString()).toBe(
      '2026-03-02T23:00:00.000Z',
    );
  });

  it('handles summer time (CEST, UTC+2)', () => {
    const noon = new Date('2026-07-15T10:00:00Z');
    expect(berlinDayStart(noon).toISOString()).toBe('2026-07-14T22:00:00.000Z');
    expect(berlinNextDayStart(noon).toISOString()).toBe(
      '2026-07-15T22:00:00.000Z',
    );
  });

  it('gets the switch-over day right (clocks go forward 2026-03-29)', () => {
    const afterSwitch = new Date('2026-03-29T12:00:00Z'); // 14:00 CEST
    expect(berlinDayStart(afterSwitch).toISOString()).toBe(
      '2026-03-28T23:00:00.000Z', // midnight was still CET
    );
    expect(berlinNextDayStart(afterSwitch).toISOString()).toBe(
      '2026-03-29T22:00:00.000Z', // next midnight is CEST
    );
  });
});
