/**
 * Die vier Erinnerungen zu einer Veranstaltung als fertige Mail (Betreff,
 * HTML, Text). Reine Funktionen: alles, was drinsteht, kommt als Parameter
 * — so lassen sie sich ohne Datenbank testen und als HTML ansehen.
 *
 * Keine Gaestedaten: nur Namen der Veranstaltung und Produkte, Zahlen und
 * Links in die App.
 */
import {
  absatz,
  checkliste,
  datenblock,
  ersatzlink,
  escapeHtml,
  fussnote,
  hinweis,
  knopf,
  linkliste,
  rahmen,
  stapeln,
  ueberschrift,
  zwischentitel,
} from '../email/email-template';
import { dayBoundsInZone } from '../../common/utils/event-schedule.util';
import type { ChecklistItem } from './event-checklist';

export interface EventMail {
  subject: string;
  html: string;
  text: string;
}

interface MailBase {
  to: string;
  appUrl: string;
  organizationName: string;
  eventName: string;
  timeZone: string;
  /** Erster Festtag (Beginn des ersten Geschaeftstags). */
  firstDay: Date;
  now: Date;
}

// ---------------------------------------------------------------- Format

/** „Montag, 16. November 2026“ */
export function formatDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('de-DE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone,
  }).format(date);
}

/** „16. November“ */
export function formatShortDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('de-DE', {
    day: 'numeric',
    month: 'long',
    timeZone,
  }).format(date);
}

/** „18:00“ */
export function formatTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(date);
}

/** Ganze Kalendertage von `from` bis `to` in der Zeitzone (kann negativ sein). */
export function calendarDaysBetween(
  from: Date,
  to: Date,
  timeZone: string,
): number {
  const a = dayBoundsInZone(from, timeZone).key;
  const b = dayBoundsInZone(to, timeZone).key;
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/**
 * „heute, 18:00 Uhr“, „morgen, 6:00 Uhr“ oder „Sonntag, 15. November
 * 2026, 18:00 Uhr“ — relativ zu `now`.
 */
export function formatMoment(date: Date, now: Date, timeZone: string): string {
  const days = calendarDaysBetween(now, date, timeZone);
  const day =
    days === 0 ? 'heute' : days === 1 ? 'morgen' : formatDay(date, timeZone);
  return `${day}, ${formatTime(date, timeZone)} Uhr`;
}

/**
 * Eine Frist, die um Mitternacht endet, liest sich als „Ende des Vortags“:
 * „Sonntag, 8. November 2026, 24:00 Uhr“ statt „Montag, 0:00 Uhr“.
 */
export function formatDeadline(date: Date, timeZone: string): string {
  const time = formatTime(date, timeZone);
  if (time === '00:00') {
    const previous = new Date(date.getTime() - 1);
    return `${formatDay(previous, timeZone)}, 24:00 Uhr`;
  }
  return `${formatDay(date, timeZone)}, ${time} Uhr`;
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: currency || 'EUR',
    }).format(amount);
  } catch {
    return `${amount.toFixed(2).replace('.', ',')} ${currency}`;
  }
}

function formatCount(n: number): string {
  return new Intl.NumberFormat('de-DE').format(n);
}

function inDays(days: number): string {
  if (days <= 0) return 'Heute';
  if (days === 1) return 'Morgen';
  return `In ${days} Tagen`;
}

// ---------------------------------------------------------------- Fuss

function settingsLinks(appUrl: string) {
  return {
    personal: `${appUrl}/settings?tab=preferences`,
    organization: `${appUrl}/settings?tab=org-notifications`,
  };
}

function footerHtml(o: MailBase): string {
  const links = settingsLinks(o.appUrl);
  return fussnote(
    `Du bekommst diese Mail als Admin von „${escapeHtml(o.organizationName)}“. Abschalten kannst du die Erinnerungen <a href="${links.personal}" style="color:#1e5433">für dich</a> oder <a href="${links.organization}" style="color:#1e5433">für alle Admins deiner Organisation</a>.`,
    true,
  );
}

function footerText(o: MailBase): string {
  const links = settingsLinks(o.appUrl);
  return [
    `Du bekommst diese Mail als Admin von „${o.organizationName}“.`,
    `Erinnerungen für dich abschalten: ${links.personal}`,
    `Für alle Admins: ${links.organization}`,
  ].join('\n');
}

function frame(
  o: MailBase,
  subject: string,
  kontext: string,
  preheader: string,
  inhalt: string,
): string {
  return rahmen({
    kontext,
    titel: `OpenEOS — ${subject}`,
    preheader,
    empfaenger: o.to,
    appUrl: o.appUrl,
    benachrichtigungenUrl: settingsLinks(o.appUrl).organization,
    inhalt,
  });
}

const SYMBOL: Record<ChecklistItem['status'], string> = {
  ok: '✓',
  todo: '✗',
  info: '–',
};

// ------------------------------------------------- 1. Dein Fest rückt näher

export interface WeekBeforeMailInput extends MailBase {
  checklist: ChecklistItem[];
  /** Verkaufsstart; `null` ohne Datumsphasen (dann kein Testbetrieb-Hinweis). */
  realSalesFrom: Date | null;
  presaleEnabled: boolean;
}

export function weekBeforeMail(o: WeekBeforeMailInput): EventMail {
  const day = formatDay(o.firstDay, o.timeZone);
  const subject = `Dein Fest rückt näher: „${o.eventName}“ am ${formatShortDay(o.firstDay, o.timeZone)}`;
  const days = calendarDaysBetween(o.now, o.firstDay, o.timeZone);
  const intro = `${inDays(days)} ist es so weit: „${o.eventName}“ beginnt am ${day}. Hier siehst du, was schon steht und was noch fehlt – direkt aus deinen Daten in OpenEOS.`;
  const open = o.checklist.filter((i) => i.status === 'todo').length;
  const summary =
    open === 0
      ? 'Alles Wichtige ist erledigt. Schau trotzdem einmal drüber.'
      : open === 1
        ? 'Ein Punkt ist noch offen.'
        : `${open} Punkte sind noch offen.`;

  const testText = o.realSalesFrom
    ? `Bis zum Verkaufsstart am ${formatDay(o.realSalesFrom, o.timeZone)} um ${formatTime(o.realSalesFrom, o.timeZone)} Uhr läuft alles im Testbetrieb: Bestellungen an Kasse, Tischen und per QR-Code sind Testbestellungen. Zum Verkaufsstart löschen wir sie, deine Einrichtung bleibt. Probier also ruhig alles aus.${o.presaleEnabled ? ' Dein Shop nimmt im Vorverkauf schon jetzt echte Bestellungen an.' : ''}`
    : null;
  const eventsUrl = `${o.appUrl}/events`;

  const html = frame(
    o,
    subject,
    'Veranstaltung',
    `${inDays(days)} geht's los – ${summary}`,
    stapeln(
      ueberschrift('Dein Fest rückt näher'),
      absatz(intro),
      absatz(
        `<strong style="color:#14180f">${escapeHtml(summary)}</strong>`,
        true,
      ),
      checkliste(
        o.checklist.map((i) => ({
          stand: i.status,
          titel: i.title,
          text: i.detail,
          url: i.url,
          linkText: i.linkLabel,
        })),
      ),
      testText && hinweis('Bis zum Verkaufsstart ist alles ein Test', testText),
      knopf(eventsUrl, 'Zur Veranstaltung'),
      ersatzlink(eventsUrl),
      footerHtml(o),
    ),
  );

  const text = [
    'Dein Fest rückt näher',
    '',
    intro,
    '',
    summary,
    '',
    ...o.checklist.flatMap((i) => [
      `[${SYMBOL[i.status]}] ${i.title}`,
      `    ${i.detail}`,
      `    ${i.linkLabel}: ${i.url}`,
    ]),
    '',
    ...(testText
      ? ['Bis zum Verkaufsstart ist alles ein Test', testText, '']
      : []),
    `Zur Veranstaltung: ${eventsUrl}`,
    '',
    footerText(o),
  ].join('\n');

  return { subject, html, text };
}

// ------------------------------------------------- 2. Morgen geht's los

export type DayBeforeTse = 'active' | 'pending' | 'blocked' | null;

export interface DayBeforeMailInput extends MailBase {
  realSalesFrom: Date;
  realSalesUntil: Date;
  /** Datumsphasen aktiv: Testbestellungen werden zum Verkaufsstart geloescht. */
  datePhases: boolean;
  emergencyPhone: { phone: string; telUri: string } | null;
  /**
   * Cloud-TSE: `active` (aktiv), `pending` (wird bis zum Verkaufsstart
   * eingerichtet), `blocked` (DE „Alle Funktionen“ ohne TSE, Bargeld
   * gesperrt), `null` (kein Thema).
   */
  tse: DayBeforeTse;
}

export function dayBeforeMail(o: DayBeforeMailInput): EventMail {
  const subject = `Morgen geht's los: „${o.eventName}“`;
  const salesStart = formatMoment(o.realSalesFrom, o.now, o.timeZone);
  const intro = `Gleich ist es so weit: „${o.eventName}“ beginnt am ${formatDay(o.firstDay, o.timeZone)}. Echt verkauft wird ab ${salesStart}.`;
  const rows: [string, string][] = [
    ['Veranstaltung', o.eventName],
    ['Erster Festtag', formatDay(o.firstDay, o.timeZone)],
    ['Echter Verkauf ab', salesStart.replace(/^./, (c) => c.toUpperCase())],
    [
      'Neue Bestellungen bis',
      `${formatDay(o.realSalesUntil, o.timeZone)}, ${formatTime(o.realSalesUntil, o.timeZone)} Uhr`,
    ],
  ];
  const purgeText = o.datePhases
    ? `Zum Verkaufsstart (${salesStart}) löschen wir alle Testbestellungen dieser Veranstaltung. Ab dann zählt jede Bestellung als echter Verkauf. Kassen, Produkte und Einstellungen bleiben, wie sie sind.`
    : null;
  const tseText =
    o.tse === 'active'
      ? 'Deine Cloud-TSE ist aktiv: Barzahlungen sind freigegeben, und jeder Bon trägt die TSE-Angaben.'
      : o.tse === 'pending'
        ? 'OpenEOS richtet deine Cloud-TSE vor dem Verkaufsstart automatisch ein. Bargeld geht, sobald sie aktiv ist – den Stand siehst du unter „Cloud-TSE“.'
        : o.tse === 'blocked'
          ? 'Ohne aktive Cloud-TSE bleibt Bargeld in Deutschland gesperrt. Kassiere mit Karte oder online, oder wähle „Bargeldlos“ bzw. „Nur Bons“.'
          : null;
  const devicesUrl = `${o.appUrl}/devices`;
  const tseUrl = `${o.appUrl}/integrations/tse`;
  const phone = o.emergencyPhone;

  const html = frame(
    o,
    subject,
    'Veranstaltung',
    `Echter Verkauf ab ${salesStart}`,
    stapeln(
      ueberschrift("Morgen geht's los"),
      absatz(intro),
      datenblock('Dein Fest', rows),
      purgeText && hinweis('Testbestellungen werden gelöscht', purgeText),
      tseText &&
        absatz(
          `<strong style="color:#14180f">Cloud-TSE:</strong> ${escapeHtml(tseText)} <a href="${tseUrl}" style="color:#1e5433">Cloud-TSE öffnen</a>`,
          true,
        ),
      phone &&
        hinweis(
          'Notfall-Support am Veranstaltungstag',
          `Bei einer kritischen Störung während deines Fests erreichst du uns unter <a href="${phone.telUri}" style="color:#14180f;font-weight:bold">${escapeHtml(phone.phone)}</a>. Für alles andere ist der Support-Chat in der App da.`,
          true,
        ),
      absatz(
        'Schalte die Kassen vor dem Start einmal ein und prüf, ob sie verbunden sind – unter „Geräte“ siehst du, welche online sind.',
      ),
      knopf(devicesUrl, 'Zu den Geräten'),
      ersatzlink(devicesUrl),
      footerHtml(o),
    ),
  );

  const text = [
    "Morgen geht's los",
    '',
    intro,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    ...(purgeText ? ['Testbestellungen werden gelöscht', purgeText, ''] : []),
    ...(tseText ? [`Cloud-TSE: ${tseText}`, tseUrl, ''] : []),
    ...(phone
      ? [
          `Notfall-Support am Veranstaltungstag: ${phone.phone} – nur für kritische Störungen während deines Fests, sonst der Support-Chat in der App.`,
          '',
        ]
      : []),
    `Geräte: ${devicesUrl}`,
    '',
    footerText(o),
  ].join('\n');

  return { subject, html, text };
}

// ------------------------------------------------- 3. Danke! So lief dein Fest

export interface AfterEventStats {
  orders: number;
  revenue: number;
  itemsSold: number;
  topProducts: { name: string; quantity: number; revenue: number }[];
}

export interface AfterEventMailInput extends MailBase {
  lastDay: Date;
  ordersOnly: boolean;
  currency: string;
  stats: AfterEventStats;
  /** Bestellungen mit Bedienung → Link auf die Kellnerabrechnungen. */
  waitersUsed: boolean;
  /** Mit Cloud-TSE signiert → Kassenabschluesse und DSFinV-K. */
  tseUsed: boolean;
  /** Gaestedaten werden nach so vielen Tagen geloescht; `null`: keine Loeschung. */
  guestDataDays: number | null;
}

export function afterEventMail(o: AfterEventMailInput): EventMail {
  const subject = `Danke! So lief dein Fest „${o.eventName}“`;
  const sameDay = calendarDaysBetween(o.firstDay, o.lastDay, o.timeZone) === 0;
  const year = (d: Date) =>
    new Intl.DateTimeFormat('de-DE', {
      year: 'numeric',
      timeZone: o.timeZone,
    }).format(d);
  const when = sameDay
    ? `am ${formatDay(o.firstDay, o.timeZone)}`
    : `vom ${formatShortDay(o.firstDay, o.timeZone)} bis ${formatShortDay(o.lastDay, o.timeZone)} ${year(o.lastDay)}`;
  const intro = `„${o.eventName}“ ${when} ist vorbei – danke, dass ihr mit OpenEOS gearbeitet habt. Hier die wichtigsten Zahlen, ohne Testbestellungen und Stornos.`;
  const rows: [string, string][] = [
    ['Bestellungen', formatCount(o.stats.orders)],
    ...(o.ordersOnly
      ? []
      : ([['Umsatz', formatMoney(o.stats.revenue, o.currency)]] as [
          string,
          string,
        ][])),
    ['Verkaufte Artikel', formatCount(o.stats.itemsSold)],
  ];
  const top = o.stats.topProducts.slice(0, 3);
  const topRows: [string, string][] = top.map((p, index) => [
    `${index + 1}. Platz`,
    o.ordersOnly
      ? `${p.name} · ${formatCount(p.quantity)} Stück`
      : `${p.name} · ${formatCount(p.quantity)} Stück · ${formatMoney(p.revenue, o.currency)}`,
  ]);

  const app = o.appUrl;
  const links: { text: string; url: string; hinweis?: string }[] = [
    {
      text: 'Berichte',
      url: `${app}/reports`,
      hinweis: o.ordersOnly
        ? 'Mengen nach Produkt, Kategorie, Stunde und Gerät.'
        : 'Umsatz nach Produkt, Kategorie, Zahlungsart und Stunde, mit PDF und CSV.',
    },
    {
      text: 'Bestellungen als CSV',
      url: `${app}/orders`,
      hinweis: 'Alle Bestellungen der Veranstaltung zum Weiterrechnen.',
    },
  ];
  if (o.waitersUsed) {
    links.push({
      text: 'Kellnerabrechnungen',
      url: `${app}/waiters`,
      hinweis: 'Abrechnung je Bedienung, falls noch nicht geschehen.',
    });
  }
  if (o.tseUsed) {
    links.push({
      text: 'Kassenabschlüsse und DSFinV-K',
      url: `${app}/integrations/tse`,
      hinweis:
        'Für deine Unterlagen und eine mögliche Kassen-Nachschau des Finanzamts.',
    });
  }
  const retentionText =
    o.guestDataDays !== null
      ? `Angaben deiner Gäste in Bestellungen, etwa Name und E-Mail-Adresse aus dem Shop, löschen wir ${o.guestDataDays} Tage nach dem Ende der Veranstaltung. Brauchst du sie, exportiere sie vorher. Zahlen und Berichte bleiben erhalten.`
      : null;
  const reportsUrl = `${app}/reports`;

  const html = frame(
    o,
    subject,
    'Rückblick',
    o.ordersOnly
      ? `${formatCount(o.stats.orders)} Bestellungen`
      : `${formatCount(o.stats.orders)} Bestellungen, ${formatMoney(o.stats.revenue, o.currency)} Umsatz`,
    stapeln(
      ueberschrift('Danke! So lief dein Fest'),
      absatz(intro),
      datenblock('Zahlen', rows),
      topRows.length > 0 && datenblock('Am meisten verkauft', topRows),
      linkliste('Auswerten und exportieren', links),
      retentionText && hinweis('Gästedaten werden gelöscht', retentionText),
      knopf(reportsUrl, 'Bericht ansehen'),
      ersatzlink(reportsUrl),
      footerHtml(o),
    ),
  );

  const text = [
    'Danke! So lief dein Fest',
    '',
    intro,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    ...(topRows.length
      ? ['Am meisten verkauft:', ...topRows.map(([k, v]) => `${k}: ${v}`), '']
      : []),
    'Auswerten und exportieren:',
    ...links.map((l) => `- ${l.text}: ${l.url}`),
    '',
    ...(retentionText ? [retentionText, ''] : []),
    footerText(o),
  ].join('\n');

  return { subject, html, text };
}

// ------------------------------------------------- 4. Noch nicht freigeschaltet

export interface NotBookedMailInput extends MailBase {
  eventId: string;
  /** Obergrenze fuer Testbestellungen im Testmodus. */
  testMaxOrders: number;
  /** Ab hier wuerde nach dem Freischalten echt verkauft (Verkaufsfenster). */
  realSalesFrom: Date;
  /** Stornofrist, wenn jetzt gebucht wuerde (7 Kalendertage vor Beginn). */
  cancellationDeadline: Date | null;
  emergencySupport: boolean;
  /** Cloud-TSE gehoert zur Buchung (DE, „Alle Funktionen“). */
  tseIncluded: boolean;
}

export function notBookedMail(o: NotBookedMailInput): EventMail {
  const subject = `Dein Fest am ${formatShortDay(o.firstDay, o.timeZone)} ist noch nicht freigeschaltet`;
  const intro = `„${o.eventName}“ beginnt am ${formatDay(o.firstDay, o.timeZone)} – und läuft noch im Testmodus. Damit an dem Tag echt verkauft wird, schalte die Veranstaltung frei.`;
  const benefits = [
    `Echte Verkäufe an Kasse, Tischen, per QR-Code und im Shop, ohne Obergrenze. Im Testmodus sind es höchstens ${o.testMaxOrders} Testbestellungen.`,
    `Echt verkauft wird ab ${formatDay(o.realSalesFrom, o.timeZone)}, ${formatTime(o.realSalesFrom, o.timeZone)} Uhr; bis dahin testest du weiter. Testbestellungen löschen wir zum Verkaufsstart.`,
    ...(o.emergencySupport
      ? ['Notfall-Support per Telefon am Veranstaltungstag.']
      : []),
    ...(o.tseIncluded
      ? [
          'Die Cloud-TSE für Bargeld ist dabei und wird automatisch eingerichtet.',
        ]
      : []),
  ];
  const deadline = o.cancellationDeadline;
  const cancellationText = !deadline
    ? null
    : o.now.getTime() < deadline.getTime()
      ? `Kostenlos stornieren kannst du bis 7 Tage vor Beginn, also bis ${formatDeadline(deadline, o.timeZone)} – solange es noch keine echten Bestellungen gibt.`
      : `Kostenlos stornieren geht bis 7 Tage vor Beginn. Für diesen Termin ist die Frist am ${formatDeadline(deadline, o.timeZone)} abgelaufen – buchst du jetzt, ist die Buchung verbindlich.`;
  const unlockUrl = `${o.appUrl}/events?unlock=${encodeURIComponent(o.eventId)}`;
  const notPlanned =
    'Findet das Fest nicht statt? Dann setz die Veranstaltung auf inaktiv oder lösch sie – dann bekommst du dazu keine Erinnerungen mehr.';

  const html = frame(
    o,
    subject,
    'Veranstaltung',
    'Noch im Testmodus – jetzt freischalten',
    stapeln(
      ueberschrift('Noch nicht freigeschaltet'),
      absatz(intro),
      zwischentitel('Mit der Freischaltung') +
        benefits
          .map((b) =>
            absatz(
              `<span style="color:#1e5433;font-weight:bold">&#10003;</span>&nbsp; ${escapeHtml(b)}`,
              true,
            ),
          )
          .join(''),
      cancellationText && hinweis('Kostenlos stornieren', cancellationText),
      knopf(unlockUrl, 'Jetzt freischalten'),
      ersatzlink(unlockUrl),
      absatz(notPlanned),
      footerHtml(o),
    ),
  );

  const text = [
    'Noch nicht freigeschaltet',
    '',
    intro,
    '',
    'Mit der Freischaltung:',
    ...benefits.map((b) => `- ${b}`),
    '',
    ...(cancellationText ? [cancellationText, ''] : []),
    `Jetzt freischalten: ${unlockUrl}`,
    '',
    notPlanned,
    '',
    footerText(o),
  ].join('\n');

  return { subject, html, text };
}
