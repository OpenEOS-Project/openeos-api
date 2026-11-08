import {
  Event,
  EventStatus,
  ShopOpeningHours,
  ShopWeekday,
} from '../../database/entities/event.entity';
import {
  ShopDayWindow,
  ShopWindow,
  dayWindowsToAbsolute,
  deriveShopWindows,
  isWithinShopWindows,
  listEventDayKeys,
} from '../../common/utils/event-schedule.util';
import { EventPhaseInfo } from '../../common/utils/event-phase.util';

const WEEKDAY_KEYS: ShopWeekday[] = [
  'sun',
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
];

function parseHHMM(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Woraus sich die Oeffnungszeiten dieses Shops ergeben.
 *
 * Neue Shops leiten sie aus dem Veranstaltungszeitraum ab. Shops, die noch
 * eine ausgefuellte Wochentags-Tabelle mitbringen, bleiben darauf, bis sie
 * bewusst umgestellt werden — sonst wuerde ein Bestandsshop von heute auf
 * morgen zu anderen Zeiten oeffnen.
 */
export function resolveShopHoursMode(
  hoursMode: 'event' | 'weekly' | undefined,
  hours: ShopOpeningHours | null | undefined,
): 'event' | 'weekly' {
  if (hoursMode) return hoursMode;
  const hasWeeklyTable = hours
    ? WEEKDAY_KEYS.some((k) => hours[k] !== undefined)
    : false;
  return hasWeeklyTable ? 'weekly' : 'event';
}

/** Die konkreten Zeitfenster dieses Shops, unabhaengig vom gewaehlten Modus. */
export function resolveShopWindows(
  event: Event,
  timeZone: string,
): ShopWindow[] {
  const shop = event.settings?.shop;
  const hours = shop?.openingHours ?? null;
  if (resolveShopHoursMode(shop?.hoursMode, hours) === 'event') {
    // Die eingetragenen Tagesfenster haben Vorrang. Nur wenn keine da sind
    // — Shops aus der ersten Fassung — wird ersatzweise abgeleitet.
    if (shop?.days && shop.days.length > 0) {
      return dayWindowsToAbsolute(shop.days, timeZone);
    }
    return deriveShopWindows(event.startDate, event.endDate, timeZone);
  }
  return weeklyHoursToWindows(event, hours, timeZone);
}

/**
 * Die Wochentags-Tabelle in dieselben Fenster uebersetzen, die der
 * abgeleitete Modus liefert — so kennt der Shop nur noch eine Darstellung.
 * Erzeugt werden die Fenster fuer den Veranstaltungszeitraum, hoechstens
 * aber fuer 31 Tage.
 *
 * Tage und Uhrzeiten gelten in der Zeitzone der Organisation, nicht in der
 * des Servers: "Samstag 10 bis 18 Uhr" heisst 10 Uhr Ortszeit, auch auf
 * einem Server in UTC und auch in der Woche, in der die Sommerzeit endet.
 * Deshalb laeuft die Rechnung ueber dieselben Kalendertage und dieselbe
 * Umrechnung wie im Veranstaltungsmodus.
 */
function weeklyHoursToWindows(
  event: Event,
  hours: ShopOpeningHours | null,
  timeZone: string,
): ShopWindow[] {
  if (!hours || !event.startDate) return [];
  return weeklyHoursForDays(
    hours,
    listEventDayKeys(event.startDate, event.endDate, timeZone),
    timeZone,
  );
}

/**
 * Die Wochentags-Tabelle fuer bestimmte Kalendertage (hoechstens 31) — fuer
 * den Veranstaltungszeitraum und fuer die Tage des Vorverkaufs.
 */
export function weeklyHoursForDays(
  hours: ShopOpeningHours | null | undefined,
  dayKeys: string[],
  timeZone: string,
): ShopWindow[] {
  if (!hours) return [];
  const days: ShopDayWindow[] = [];

  for (const date of dayKeys.slice(0, 31)) {
    // Der Wochentag eines Kalendertags haengt nicht an der Zeitzone — der
    // Tag selbst stammt schon aus der Ortszeit.
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const window = hours[WEEKDAY_KEYS[weekday]];
    if (!window) continue;
    const from = parseHHMM(window.start);
    const until = parseHHMM(window.end);
    // Anders als die Tagesfenster kennt die Wochentags-Tabelle keine
    // Nacht ueber Mitternacht; solche Eintraege galten schon immer als leer.
    if (from === null || until === null || until <= from) continue;
    days.push({ date, start: window.start, end: window.end });
  }
  return dayWindowsToAbsolute(days, timeZone);
}

/**
 * Zustand des Shops:
 * - `test`: Testmodus der Veranstaltung — immer offen, Testbestellungen;
 * - `presale`: Vorverkauf vor dem Verkaufsfenster, gerade offen;
 * - `open`: Verkaufsfenster, gerade innerhalb der Oeffnungszeiten;
 * - `closed`: ausserhalb der Oeffnungszeiten (Vorverkauf oder Verkaufsfenster);
 * - `not_started`: geplant, ohne Vorverkauf — Bestellungen erst ab dem
 *   Verkaufsfenster;
 * - `ended`: Veranstaltung beendet.
 */
export type ShopState =
  | 'test'
  | 'presale'
  | 'open'
  | 'closed'
  | 'not_started'
  | 'ended';

export interface ShopAvailability {
  state: ShopState;
  isOpenNow: boolean;
  /** Oeffnungszeiten im Verkaufsfenster (an Beginn und Ende gekappt). */
  windows: ShopWindow[];
  /** Zeiten des Vorverkaufs; `null` ohne Vorverkauf bzw. ausserhalb „Geplant“. */
  presaleWindows: ShopWindow[] | null;
  nextOpening: string | null;
}

function clip(
  windows: ShopWindow[],
  from: string | null,
  until: string | null,
): ShopWindow[] {
  const lower = from ? new Date(from).getTime() : -Infinity;
  const upper = until ? new Date(until).getTime() : Infinity;
  return windows
    .map((w) => ({
      start: new Date(Math.max(new Date(w.start).getTime(), lower)),
      end: new Date(Math.min(new Date(w.end).getTime(), upper)),
    }))
    .filter((w) => w.end.getTime() > w.start.getTime())
    .map((w) => ({ start: w.start.toISOString(), end: w.end.toISOString() }));
}

/**
 * Wann der Shop Bestellungen annimmt (Entscheidung 2026-11-08):
 *
 * - Im Verkaufsfenster gelten die Oeffnungszeiten wie bisher, gekappt auf
 *   `realSalesFrom`..`realSalesUntil` — nach dem Ende nimmt auch der Shop
 *   nichts mehr an.
 * - Vor dem Verkaufsfenster („Geplant“) nur mit Vorverkauf
 *   (`settings.sales.presale`), dann echte Bestellungen. Die
 *   Wochentags-Tabelle gilt auch an den Tagen des Vorverkaufs; Tagesfenster
 *   gibt es nur fuer Veranstaltungstage, also ist der Vorverkauf dort
 *   durchgehend offen, bis das Verkaufsfenster beginnt.
 * - Testmodus: immer offen (Testbestellungen), wie bisher.
 */
export function shopAvailability(
  event: Event,
  timeZone: string,
  info: EventPhaseInfo,
  now: Date = new Date(),
): ShopAvailability {
  const allWindows = resolveShopWindows(event, timeZone);

  if (event.status === EventStatus.TEST || info.phase === 'test') {
    return {
      state: 'test',
      isOpenNow: true,
      windows: allWindows,
      presaleWindows: null,
      nextOpening: null,
    };
  }

  const windows = clip(allWindows, info.realSalesFrom, info.realSalesUntil);
  const nextOf = (list: ShopWindow[]): string | null =>
    list.map((w) => w.start).find((iso) => new Date(iso) > now) ?? null;

  if (info.phase === 'ended') {
    return {
      state: 'ended',
      isOpenNow: false,
      windows,
      presaleWindows: null,
      nextOpening: null,
    };
  }

  if (info.phase === 'planned') {
    if (!info.presaleEnabled || !info.realSalesFrom) {
      return {
        state: 'not_started',
        isOpenNow: false,
        windows,
        presaleWindows: null,
        nextOpening: nextOf(windows),
      };
    }
    const shop = event.settings?.shop;
    const weekly =
      resolveShopHoursMode(shop?.hoursMode, shop?.openingHours ?? null) ===
      'weekly';
    const presaleWindows = weekly
      ? clip(
          weeklyHoursForDays(
            shop?.openingHours,
            listEventDayKeys(now, info.realSalesFrom, timeZone),
            timeZone,
          ),
          null,
          info.realSalesFrom,
        )
      : [{ start: now.toISOString(), end: info.realSalesFrom }];
    const isOpenNow = weekly
      ? isWithinShopWindows(now, presaleWindows)
      : now.getTime() < new Date(info.realSalesFrom).getTime();
    return {
      state: isOpenNow ? 'presale' : 'closed',
      isOpenNow,
      windows,
      presaleWindows,
      nextOpening: isOpenNow ? null : nextOf([...presaleWindows, ...windows]),
    };
  }

  const isOpenNow = isWithinShopWindows(now, windows);
  return {
    state: isOpenNow ? 'open' : 'closed',
    isOpenNow,
    windows,
    presaleWindows: null,
    nextOpening: nextOf(windows),
  };
}
