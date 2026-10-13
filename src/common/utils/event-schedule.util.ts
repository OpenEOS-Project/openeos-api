/**
 * Zeitplan einer Veranstaltung: wie viele Tage sie dauert und wann der
 * Online-Shop an jedem davon geoeffnet ist.
 *
 * Eine Veranstaltung ist ein Bereich aus Kalendertagen — Freitag bis
 * Sonntag sind drei Tage. Die Uhrzeiten stecken nicht darin, sondern in den
 * Oeffnungszeiten, und die werden je Tag einzeln gesetzt: freitags 18 bis
 * 22 Uhr, samstags 10 bis 2 Uhr, sonntags 14 bis 18 Uhr.
 *
 * Abgerechnet wird dagegen nach Geschaeftstagen (countBillableDays): ein
 * Veranstaltungstag laeuft von 6 bis 6 Uhr, eine Nacht bis 2 Uhr zaehlt
 * also noch zum Vortag. Shop-Tage und Tageslisten bleiben Kalendertage
 * (countCalendarDays, listEventDayKeys) — dort geht es ums Datum, nicht um
 * den Preis.
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
  const target = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
  );
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

/**
 * Kalendertag eines Zeitpunkts in einer Zeitzone samt seiner Grenzen:
 * `start` ist Mitternacht dieses Tages, `end` Mitternacht des Folgetages
 * (exklusiv). An Tagen mit Zeitumstellung ist der Tag 23 bzw. 25 Stunden lang.
 */
export function dayBoundsInZone(
  date: Date | string,
  timeZone: string,
): { key: string; start: Date; end: Date } {
  const day = dayNumber(toWallClock(toDate(date), timeZone));
  return {
    key: toDateKey(date, timeZone),
    start: fromWallClock(dayToWallClock(day, 0, 0), timeZone),
    end: fromWallClock(dayToWallClock(day + 1, 0, 0), timeZone),
  };
}

/** 'YYYY-MM-DD' in die Tageszahl, mit der sich rechnen laesst. */
function dateKeyToDayNumber(dateKey: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return null;
  return (
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) /
    MS_PER_DAY
  );
}

function parseHHMM(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value ?? '');
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** Standard-Tageswechsel fuer die Abrechnung: 6 Uhr Ortszeit. */
export const DEFAULT_BUSINESS_DAY_START_HOUR = 6;

/**
 * Den konfigurierten Tageswechsel auf eine brauchbare Stunde bringen.
 *
 * Erlaubt ist 1 bis 23. Null scheidet aus: Veranstaltungen aus dem
 * Formular liegen auf Mitternacht, und mit einem Tageswechsel um 0 Uhr
 * fiele ihr Ende (exklusiv) auf den Vortag — Freitag bis Sonntag ergaebe
 * zwei Tage statt drei. Alles andere faellt auf den Standard zurueck.
 */
export function normalizeBusinessDayStartHour(value: unknown): number {
  const hour = typeof value === 'string' ? Number(value) : value;
  return typeof hour === 'number' &&
    Number.isInteger(hour) &&
    hour >= 1 &&
    hour <= 23
    ? hour
    : DEFAULT_BUSINESS_DAY_START_HOUR;
}

/**
 * Geschaeftstag eines Zeitpunkts als Tageszahl: der Kalendertag seiner
 * Wanduhrzeit, vor dem Tageswechsel der Vortag. Samstag 3 Uhr gehoert so
 * zum Freitag.
 *
 * Gerechnet wird ueber die Wanduhrzeit, nicht ueber eine feste Verschiebung
 * um sechs Stunden — sonst verrutschte die Grenze in der Nacht der
 * Zeitumstellung um eine Stunde.
 */
function businessDayNumber(
  date: Date,
  timeZone: string,
  dayStartHour: number,
): number {
  const wall = toWallClock(date, timeZone);
  const day = dayNumber(wall);
  return wall.hour < dayStartHour ? day - 1 : day;
}

/** Beginn und Ende lesen; ohne (lesbares) Ende endet die Veranstaltung mit ihrem Beginn. */
function readRange(
  startDate: Date | string | null | undefined,
  endDate: Date | string | null | undefined,
): { start: Date; end: Date } | null {
  if (!startDate) return null;
  const start = toDate(startDate);
  if (Number.isNaN(start.getTime())) return null;
  const end = endDate ? toDate(endDate) : start;
  return { start, end: Number.isNaN(end.getTime()) ? start : end };
}

/**
 * Anzahl der abgerechneten Veranstaltungstage — die Groesse, nach der die
 * Freischaltung bezahlt wird.
 *
 * Gezaehlt werden Geschaeftstage: ein Tag beginnt um `dayStartHour`
 * (Standard 6 Uhr) Ortszeit der Organisation und endet um dieselbe Uhrzeit
 * am Folgetag. Samstag 20 Uhr bis Sonntag 2 Uhr ist damit ein Tag, Freitag
 * 17 Uhr bis Sonntag 18 Uhr bleiben drei.
 *
 * Ein Beginn vor dem Tageswechsel gehoert zum Vortag. Das Ende ist
 * exklusiv, wie bei den Shop-Fenstern: wer um genau 6 Uhr aufhoert, hat vom
 * naechsten Geschaeftstag keine Minute genutzt, also zaehlt das Ende bis
 * einschliesslich 6:00 zum Vortag. Erst 6:01 beginnt einen neuen Tag.
 *
 * Das Formular schickt reine Daten als Mitternacht. Beginn und Ende
 * rutschen dann beide auf den Vortag, die Zahl bleibt die der
 * Kalendertage — Freitag bis Sonntag sind weiterhin drei.
 *
 * Immer mindestens einer; ein Ende vor dem Beginn wird als eintaegig
 * gewertet, statt eine negative Rechnung zu erzeugen.
 */
export function countBillableDays(
  startDate: Date | string | null | undefined,
  endDate: Date | string | null | undefined,
  timeZone: string,
  dayStartHour: number = DEFAULT_BUSINESS_DAY_START_HOUR,
): number {
  const range = readRange(startDate, endDate);
  if (!range || range.end.getTime() <= range.start.getTime()) return 1;
  const hour = normalizeBusinessDayStartHour(dayStartHour);

  const firstDay = businessDayNumber(range.start, timeZone, hour);
  // Eine Millisekunde vor dem Ende: das Ende selbst gehoert nicht mehr dazu.
  const lastDay = businessDayNumber(
    new Date(range.end.getTime() - 1),
    timeZone,
    hour,
  );
  return Math.max(1, lastDay - firstDay + 1);
}

/**
 * Anzahl der Kalendertage einschliesslich beider Enden: Freitag bis
 * Sonntag sind drei, egal zu welcher Uhrzeit. Das ist die Tagesliste des
 * Shops und des Formulars — und die Regel, nach der vor der Umstellung auf
 * Geschaeftstage abgerechnet wurde.
 *
 * Immer mindestens einer; ein Ende vor dem Beginn ergibt einen Tag.
 */
export function countCalendarDays(
  startDate: Date | string | null | undefined,
  endDate: Date | string | null | undefined,
  timeZone: string,
): number {
  const range = readRange(startDate, endDate);
  if (!range) return 1;

  const firstDay = dayNumber(toWallClock(range.start, timeZone));
  const lastDay = dayNumber(toWallClock(range.end, timeZone));
  if (lastDay <= firstDay) return 1;
  return lastDay - firstDay + 1;
}

/**
 * Datum aus einer Anfrage lesen. Ein reines 'YYYY-MM-DD' ist Mitternacht in
 * der Zeitzone der Organisation — `new Date('2026-10-17')` waere
 * Mitternacht UTC und laege je nach Zone auf einer anderen Uhrzeit, im
 * ungluecklichen Fall genau auf dem Tageswechsel.
 */
export function parseEventDateInput(value: string, timeZone: string): Date {
  const day = dateKeyToDayNumber(value);
  if (day === null) return new Date(value);
  return fromWallClock(dayToWallClock(day, 0, 0), timeZone);
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

  const days = countCalendarDays(startDate, endDate, timeZone);
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

    const overnight =
      until.hour * 60 + until.minute <= from.hour * 60 + from.minute;
    windows.push({
      start: fromWallClock(
        dayToWallClock(dayNo, from.hour, from.minute),
        timeZone,
      ).toISOString(),
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
  const endWall = toWallClock(
    Number.isNaN(end.getTime()) ? start : end,
    timeZone,
  );

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
export function isWithinShopWindows(
  now: Date,
  windows: ShopWindow[] | null | undefined,
): boolean {
  if (!windows || windows.length === 0) return false;
  const at = now.getTime();
  return windows.some((w) => {
    const from = new Date(w.start).getTime();
    const until = new Date(w.end).getTime();
    return at >= from && at < until;
  });
}

/**
 * Denselben Zeitpunkt um `days` Kalendertage verschieben — gleiche
 * Wanduhrzeit in der Zeitzone, auch ueber eine Zeitumstellung hinweg.
 * Freitag 17 Uhr minus sieben Tage ist wieder Freitag 17 Uhr, nicht 16
 * oder 18 Uhr, wie es eine Rechnung mit 7 × 24 Stunden ergaebe.
 */
export function shiftCalendarDaysInZone(
  date: Date | string,
  days: number,
  timeZone: string,
): Date {
  const wall = toWallClock(toDate(date), timeZone);
  return fromWallClock(
    dayToWallClock(dayNumber(wall) + days, wall.hour, wall.minute),
    timeZone,
  );
}
