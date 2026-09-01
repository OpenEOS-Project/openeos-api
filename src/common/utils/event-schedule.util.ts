/**
 * Zeitplan einer Veranstaltung: wie viele Tage sie dauert und wann der
 * Online-Shop an jedem davon geoeffnet ist.
 *
 * Eine Veranstaltung ist ein Bereich aus Kalendertagen — Freitag bis
 * Sonntag sind drei Tage, danach wird abgerechnet. Die Uhrzeiten stecken
 * nicht darin, sondern in den Oeffnungszeiten, und die werden je Tag
 * einzeln gesetzt: freitags 18 bis 22 Uhr, samstags 10 bis 2 Uhr,
 * sonntags 14 bis 18 Uhr.
 *
 * Der Fall ueber Mitternacht ergibt sich daraus von selbst. Liegt die
 * Endzeit eines Tages nicht nach seiner Startzeit, laeuft das Fenster in
 * den Folgetag — "10 bis 2 Uhr" ist eine Nacht, keine Falscheingabe.
 *
 * Gerechnet wird in der Zeitzone der Organisation, nicht in UTC. Ein Fest
 * beginnt um 18 Uhr Ortszeit, auch wenn zwischendurch die Sommerzeit endet
 * und der Tag 25 Stunden hat. Deshalb laeuft die Arithmetik ueber
 * Wanduhrzeiten und Intl, nicht ueber Millisekunden-Addition.
 */

/**
 * Ein Oeffnungsfenster, wie es der Nutzer eintraegt: ein Veranstaltungstag
 * und die Uhrzeiten dazu.
 */
export interface ShopDayWindow {
  /** Der Veranstaltungstag als 'YYYY-MM-DD'. */
  date: string;
  /** 'HH:mm' */
  start: string;
  /** 'HH:mm'. Nicht spaeter als `start` heisst: am Folgetag. */
  end: string;
}

export interface ShopWindow {
  /** ISO-Zeitpunkt, ab dem der Shop offen ist. */
  start: string;
  /** ISO-Zeitpunkt, ab dem er wieder zu ist. Kann im naechsten Kalendertag liegen. */
  end: string;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Wanduhrzeit eines Zeitpunkts in einer Zeitzone. */
function toWallClock(date: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);

  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
  };
}

/**
 * Umkehrung von toWallClock: welcher Zeitpunkt zeigt in dieser Zone diese
 * Wanduhrzeit?
 *
 * Es gibt dafuer keine eingebaute Funktion. Der Trick: die Wanduhrzeit
 * zunaechst als UTC lesen, den Fehler messen und ihn abziehen. Zwei
 * Durchgaenge, weil die Korrektur selbst ueber eine Zeitumstellung springen
 * kann — an einer Sommerzeitgrenze stimmt der erste Versuch sonst um eine
 * Stunde nicht.
 */
function fromWallClock(wall: WallClock, timeZone: string): Date {
  const target = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  let guess = target;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const actual = toWallClock(new Date(guess), timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
    );
    const drift = target - actualAsUtc;
    if (drift === 0) break;
    guess += drift;
  }

  return new Date(guess);
}

/** Kalendertag einer Wanduhrzeit als Zahl, damit sich Tage subtrahieren lassen. */
function dayNumber(wall: WallClock): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day) / MS_PER_DAY;
}

function dayToWallClock(day: number, hour: number, minute: number): WallClock {
  const date = new Date(day * MS_PER_DAY);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour,
    minute,
  };
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Kalendertag eines Zeitpunkts in einer Zeitzone, als 'YYYY-MM-DD'. */
export function toDateKey(date: Date | string, timeZone: string): string {
  const wall = toWallClock(toDate(date), timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
}

/** 'YYYY-MM-DD' in die Tageszahl, mit der sich rechnen laesst. */
function dateKeyToDayNumber(dateKey: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / MS_PER_DAY;
}

function parseHHMM(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value ?? '');
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Anzahl der Veranstaltungstage — die Groesse, nach der abgerechnet wird.
 *
 * Gezaehlt werden Kalendertage einschliesslich beider Enden: Freitag bis
 * Sonntag sind drei. Immer mindestens einer; ein Ende vor dem Beginn wird
 * als eintaegig gewertet, statt eine negative Rechnung zu erzeugen.
 */
export function countEventDays(
  startDate: Date | string | null | undefined,
  endDate: Date | string | null | undefined,
  timeZone: string,
): number {
  if (!startDate) return 1;
  const start = toDate(startDate);
  if (Number.isNaN(start.getTime())) return 1;
  const end = endDate ? toDate(endDate) : start;
  const effectiveEnd = Number.isNaN(end.getTime()) ? start : end;

  const firstDay = dayNumber(toWallClock(start, timeZone));
  const lastDay = dayNumber(toWallClock(effectiveEnd, timeZone));
  if (lastDay <= firstDay) return 1;
  return lastDay - firstDay + 1;
}

/** Die Kalendertage einer Veranstaltung als 'YYYY-MM-DD', der Reihe nach. */
export function listEventDayKeys(
  startDate: Date | string | null | undefined,
  endDate: Date | string | null | undefined,
  timeZone: string,
): string[] {
  if (!startDate) return [];
  const start = toDate(startDate);
  if (Number.isNaN(start.getTime())) return [];

  const days = countEventDays(startDate, endDate, timeZone);
  const firstDay = dayNumber(toWallClock(start, timeZone));
  const pad = (n: number) => String(n).padStart(2, '0');

  return Array.from({ length: days }, (_, offset) => {
    const wall = dayToWallClock(firstDay + offset, 0, 0);
    return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
  });
}

/**
 * Die eingetragenen Tagesfenster in absolute Zeitpunkte uebersetzen.
 *
 * Endet ein Tag nicht spaeter, als er beginnt, gehoert sein Ende auf den
 * Folgetag — so wird aus "10 bis 2 Uhr" eine Nacht statt eines Fensters
 * mit negativer Laenge. Unlesbare Eintraege werden uebergangen, damit ein
 * einzelner Tippfehler in den Einstellungen nicht den ganzen Shop schliesst.
 */
export function dayWindowsToAbsolute(
  days: ShopDayWindow[] | null | undefined,
  timeZone: string,
): ShopWindow[] {
  if (!days || days.length === 0) return [];

  const windows: ShopWindow[] = [];
  for (const day of days) {
    const dayNo = dateKeyToDayNumber(day.date);
    const from = parseHHMM(day.start);
    const until = parseHHMM(day.end);
    if (dayNo === null || !from || !until) continue;

    const overnight = until.hour * 60 + until.minute <= from.hour * 60 + from.minute;
    windows.push({
      start: fromWallClock(dayToWallClock(dayNo, from.hour, from.minute), timeZone).toISOString(),
      end: fromWallClock(
        dayToWallClock(dayNo + (overnight ? 1 : 0), until.hour, until.minute),
        timeZone,
      ).toISOString(),
    });
  }
  return windows;
}

/**
 * Ruecklaeufige Voreinstellung fuer Shops, die noch keine Tagesfenster
 * haben: je Veranstaltungstag ein Fenster mit den Uhrzeiten aus Beginn und
 * Ende der Veranstaltung. Neu angelegte Shops gehen diesen Weg nicht mehr,
 * Bestandsdaten aus der ersten Fassung schon.
 */
export function deriveShopWindows(
  startDate: Date | string | null | undefined,
  endDate: Date | string | null | undefined,
  timeZone: string,
): ShopWindow[] {
  if (!startDate) return [];
  const start = toDate(startDate);
  if (Number.isNaN(start.getTime())) return [];
  const end = endDate ? toDate(endDate) : start;

  const startWall = toWallClock(start, timeZone);
  const endWall = toWallClock(Number.isNaN(end.getTime()) ? start : end, timeZone);

  return dayWindowsToAbsolute(
    listEventDayKeys(startDate, endDate, timeZone).map((date) => ({
      date,
      start: `${String(startWall.hour).padStart(2, '0')}:${String(startWall.minute).padStart(2, '0')}`,
      end: `${String(endWall.hour).padStart(2, '0')}:${String(endWall.minute).padStart(2, '0')}`,
    })),
    timeZone,
  );
}

/** Faellt der Zeitpunkt in eines der Fenster? Ende exklusiv. */
export function isWithinShopWindows(now: Date, windows: ShopWindow[] | null | undefined): boolean {
  if (!windows || windows.length === 0) return false;
  const at = now.getTime();
  return windows.some((w) => {
    const from = new Date(w.start).getTime();
    const until = new Date(w.end).getTime();
    return at >= from && at < until;
  });
}
