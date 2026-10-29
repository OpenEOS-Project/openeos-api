/**
 * Kalendertag in Europe/Berlin — unabhaengig von der Zeitzone des
 * Prozesses (CI laeuft in UTC, der Container in Berlin).
 *
 * Die Kontingente zaehlen je Kalendertag: um Mitternacht Berliner Zeit
 * beginnt ein neuer, auch an den Tagen des Zeitumstellungswechsels.
 */
export const QUOTA_TIMEZONE = 'Europe/Berlin';

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: QUOTA_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function berlinParts(date: Date): Parts {
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** Versatz der Zone zu UTC an diesem Zeitpunkt in Minuten. */
function offsetMinutes(date: Date): number {
  const p = berlinParts(date);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** 'YYYY-MM-DD' des Berliner Kalendertags. */
export function berlinDateKey(date: Date): string {
  const p = berlinParts(date);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Mitternacht (Beginn) des Berliner Kalendertags als Zeitpunkt. */
export function berlinDayStart(date: Date): Date {
  const p = berlinParts(date);
  const guess = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0);
  // Versatz an der Mitternacht selbst (nicht am Ausgangszeitpunkt), damit
  // der Tag der Zeitumstellung stimmt.
  const first = new Date(guess - offsetMinutes(new Date(guess)) * 60000);
  return new Date(guess - offsetMinutes(first) * 60000);
}

/** Beginn des naechsten Berliner Kalendertags — wann das Kontingent neu startet. */
export function berlinNextDayStart(date: Date): Date {
  const start = berlinDayStart(date);
  return berlinDayStart(new Date(start.getTime() + 36 * 60 * 60 * 1000));
}
