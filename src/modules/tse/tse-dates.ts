/**
 * Datumshilfen in deutscher Zeit (Europe/Berlin) fuer die Regeln der
 * TSE-Anlage: Kalendermonat einer Veranstaltung, Geschaeftstag 6–6 Uhr.
 */
export const TSE_TIME_ZONE = 'Europe/Berlin';

export interface LocalParts {
  year: number;
  month: number; // 1..12
  day: number;
  hour: number;
  minute: number;
}

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TSE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export function localParts(date: Date): LocalParts {
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
  };
}

/** UTC-Zeitpunkt fuer eine Ortszeit in Berlin (Sommer-/Winterzeit beachtet). */
export function berlinTime(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  // Zweimal korrigieren reicht auch an Umstellungstagen.
  let result = guess;
  for (let i = 0; i < 2; i++) {
    const p = localParts(result);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const diff = asUtc - result.getTime();
    result = new Date(guess.getTime() - diff);
  }
  return result;
}

/** `YYYY-MM-DD` in Berlin. */
export function localDate(date: Date): string {
  const p = localParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Erster Tag des Kalendermonats (Berlin) als Zeitpunkt (00:00 Ortszeit). */
export function startOfLocalMonth(date: Date): Date {
  const p = localParts(date);
  return berlinTime(p.year, p.month, 1);
}

export function sameLocalMonth(a: Date, b: Date): boolean {
  const pa = localParts(a);
  const pb = localParts(b);
  return pa.year === pb.year && pa.month === pb.month;
}

/**
 * Ende des Geschaeftstags, in dem `end` liegt: der naechste Tageswechsel
 * um `startHour` Uhr Ortszeit (Standard 6 Uhr, BUSINESS_DAY_START_HOUR).
 */
export function businessDayEnd(end: Date, startHour = 6): Date {
  const p = localParts(end);
  const sameDay = berlinTime(p.year, p.month, p.day, startHour);
  if (sameDay.getTime() > end.getTime()) return sameDay;
  const next = new Date(
    berlinTime(p.year, p.month, p.day, 12).getTime() + 24 * 3600_000,
  );
  const n = localParts(next);
  return berlinTime(n.year, n.month, n.day, startHour);
}

/**
 * Bis wann eine Veranstaltung beginnen muss, damit die automatische Anlage
 * heute greift: Ende des Geschaeftstags, der am heutigen Kalendertag
 * (Berlin) um `startHour` Uhr beginnt — also morgen `startHour` Uhr.
 */
export function autoCreateHorizon(now: Date, startHour = 6): Date {
  const p = localParts(now);
  const noonTomorrow = new Date(
    berlinTime(p.year, p.month, p.day, 12).getTime() + 24 * 3600_000,
  );
  const t = localParts(noonTomorrow);
  return berlinTime(t.year, t.month, t.day, startHour);
}
