/**
 * Zeitplan einer Veranstaltung: Wie viele Tage sie dauert und wann der
 * Online-Shop davon abgeleitet geoeffnet ist.
 *
 * Der Kern ist der Begriff *Veranstaltungstag*. Ein Kalendertag endet um
 * Mitternacht, ein Fest nicht: Wer samstags um 18 Uhr aufmacht und sonntags
 * um 3 Uhr schliesst, hatte eine Veranstaltung, nicht zwei. Ein
 * Veranstaltungstag laeuft deshalb von 06:00 bis 06:00 des Folgetags. Alles,
 * was vor dem Morgengrauen passiert, zaehlt noch zum Vortag — und zwar
 * sowohl bei der Abrechnung als auch bei den Oeffnungszeiten.
 *
 * Gerechnet wird in der Zeitzone der Organisation, nicht in UTC. Ein Fest
 * beginnt um 18 Uhr Ortszeit, auch wenn zwischendurch die Sommerzeit endet
 * und der Tag 25 Stunden hat. Deshalb laeuft die Arithmetik ueber
 * Wanduhrzeiten und Intl, nicht ueber Millisekunden-Addition.
 */

/** Beginn eines Veranstaltungstags (Ortszeit). */
export const EVENT_DAY_START_HOUR = 6;

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

/**
 * Auf welchen Veranstaltungstag faellt dieser Zeitpunkt? Die Stunden vor
 * EVENT_DAY_START_HOUR gehoeren noch zum Vortag.
 */
function eventDayNumber(date: Date, timeZone: string): number {
  const wall = toWallClock(date, timeZone);
  const day = dayNumber(wall);
  return wall.hour < EVENT_DAY_START_HOUR ? day - 1 : day;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Anzahl der Veranstaltungstage — die Groesse, nach der abgerechnet wird.
 * Immer mindestens 1; ein Ende vor dem Beginn wird als eintaegig gewertet,
 * statt eine negative Rechnung zu erzeugen.
 */
export function countEventDays(
  startDate: Date | string | null | undefined,
  endDate: Date | string | null | undefined,
  timeZone: string,
): number {
  if (!startDate) return 1;
  const start = toDate(startDate);
  const end = endDate ? toDate(endDate) : start;
  if (Number.isNaN(start.getTime())) return 1;
  if (Number.isNaN(end.getTime())) return 1;

  const firstDay = eventDayNumber(start, timeZone);
  const lastDay = eventDayNumber(end, timeZone);
  if (lastDay <= firstDay) return 1;
  return lastDay - firstDay + 1;
}

/**
 * Oeffnungszeiten aus dem Veranstaltungszeitraum ableiten: je
 * Veranstaltungstag ein Fenster, das die Uhrzeiten von Beginn und Ende
 * wiederholt.
 *
 * Liegt die Endzeit nicht nach der Startzeit, laeuft das Fenster ueber
 * Mitternacht hinweg in den naechsten Kalendertag — genau der Fall
 * "18 Uhr bis 3 Uhr". Sind beide Zeiten gleich (etwa weil nur ein Datum
 * ohne Uhrzeit gewaehlt wurde), ergibt sich daraus ein voller Tag.
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

  const startMinutes = startWall.hour * 60 + startWall.minute;
  const endMinutes = endWall.hour * 60 + endWall.minute;
  const overnight = endMinutes <= startMinutes;

  const days = countEventDays(startDate, endDate, timeZone);
  // Gezaehlt wird ueber Veranstaltungstage, platziert wird ueber Kalendertage.
  // Beginnt eine Veranstaltung um Mitternacht, liegt ihr Veranstaltungstag
  // wegen der 06-Uhr-Grenze noch auf dem Vortag — das Fenster gehoert
  // trotzdem auf den Tag, den der Nutzer eingetragen hat.
  const firstDay = dayNumber(startWall);

  const windows: ShopWindow[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const openDay = firstDay + offset;
    const closeDay = openDay + (overnight ? 1 : 0);
    windows.push({
      start: fromWallClock(
        dayToWallClock(openDay, startWall.hour, startWall.minute),
        timeZone,
      ).toISOString(),
      end: fromWallClock(
        dayToWallClock(closeDay, endWall.hour, endWall.minute),
        timeZone,
      ).toISOString(),
    });
  }

  return windows;
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
