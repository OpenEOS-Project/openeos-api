import {
  absatz,
  codeBlock,
  datenblock,
  ersatzlink,
  hinweis,
  knopf,
  rahmen,
  stapeln,
  ueberschrift,
} from '../email/email-template';

/** Datum fuer Mails, z. B. „4. Dezember 2026“ (Europe/Berlin). */
export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('de-DE', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Berlin',
  }).format(date);
}

export interface RetentionMail {
  subject: string;
  html: string;
  text: string;
}

const FISCAL_NOTE =
  'Das Steuerarchiv (TSE-Exporte, Kassenabschlüsse mit DSFinV-K-Export und signierte Kassenvorgänge) löschen wir nicht: Es bleibt für die gesetzliche Frist von zehn Jahren erhalten und ist auf Anfrage abrufbar.';

/** Ankuendigung: lange keine Buchung, die Organisation wird geschlossen. */
export function organizationInactivityMail(o: {
  to: string;
  appUrl: string;
  organizationName: string;
  lastActivityAt: Date;
  dueAt: Date;
  inactiveMonths: number;
  exportPeriodDays: number;
}): RetentionMail {
  const subject = `Deine Organisation „${o.organizationName}“ wird geschlossen`;
  const exportUrl = `${o.appUrl}/reports`;
  const intro = `Für deine Organisation „${o.organizationName}“ gab es seit mehr als ${o.inactiveMonths} Monaten keine Buchung. Ungenutzte Kundenkonten schließen wir nach vorheriger Ankündigung.`;
  const keep =
    'Du willst OpenEOS weiter nutzen? Dann buche bis dahin eine Veranstaltung oder schreib uns über den Support-Chat im Kundenportal – dein Konto bleibt dann bestehen.';
  const exportText = `Bis zur Schließung kannst du alle Daten im Kundenportal exportieren (Berichte als CSV, mit Cloud-TSE auch DSFinV-K- und TSE-Export). Danach stehen sie noch ${o.exportPeriodDays} Tage für einen Export auf Anfrage bereit und werden dann gelöscht.`;
  const html = rahmen({
    kontext: 'Konto',
    titel: `OpenEOS — ${subject}`,
    preheader: `Schließung frühestens am ${formatDate(o.dueAt)}`,
    empfaenger: o.to,
    appUrl: o.appUrl,
    inhalt: stapeln(
      ueberschrift(subject),
      absatz(intro),
      datenblock('Details', [
        ['Organisation', o.organizationName],
        ['Letzte Nutzung', formatDate(o.lastActivityAt)],
        ['Schließung ab', formatDate(o.dueAt)],
      ]),
      hinweis('Daten jetzt exportieren', exportText),
      knopf(exportUrl, 'Daten exportieren'),
      ersatzlink(exportUrl),
      absatz(keep),
      absatz(FISCAL_NOTE),
    ),
  });
  const text = [
    intro,
    '',
    `Organisation: ${o.organizationName}`,
    `Letzte Nutzung: ${formatDate(o.lastActivityAt)}`,
    `Schließung ab: ${formatDate(o.dueAt)}`,
    '',
    exportText,
    `Export: ${exportUrl}`,
    '',
    keep,
    '',
    FISCAL_NOTE,
  ].join('\n');
  return { subject, html, text };
}

/** Was beim endgueltigen Loeschen einer Organisation wegfaellt. */
const ORGANIZATION_DATA =
  'Artikel, Einstellungen, Bestellungen, Schichtpläne, Geräte, Zugänge und Mitgliedschaften';

const READ_ONLY_EXPORT =
  'Bis dahin ist die Organisation für ihre Admins nur noch lesend nutzbar. Melde dich an und exportiere, was du brauchst: Berichte als CSV oder PDF, Bestellungen, Kassenbuch und mit Cloud-TSE auch DSFinV-K- und TSE-Export.';

const RESTORE_ORGANIZATION =
  'Du willst die Organisation doch behalten? Als Admin kannst du die Löschung bis dahin selbst abbrechen: Melde dich an und klicke im Hinweis oben auf der Seite auf „Löschung abbrechen“.';

const REMINDER_PLAN =
  'Wir erinnern dich zehn Tage und einen Tag vorher noch einmal.';

/** „morgen“ bzw. „in 10 Tagen“. */
function inDays(days: number): string {
  return days === 1 ? 'morgen' : `in ${days} Tagen`;
}

function contactSentence(contactEmail: string | null): string | null {
  return contactEmail
    ? `Fragen, oder du kommst nicht mehr an dein Konto? Schreib uns an ${contactEmail}.`
    : null;
}

/** Erinnerung (bzw. Ankuendigung): die geloeschte Organisation wird endgueltig geloescht. */
function organizationFinalDeletionMail(o: {
  to: string;
  appUrl: string;
  organizationName: string;
  deletedAt: Date;
  closedForInactivity: boolean;
  dueAt: Date;
  contactEmail: string | null;
  /** Gesetzt bei Erinnerungen: Tage bis zum Termin. */
  daysLeft: number | null;
}): RetentionMail {
  const subject =
    o.daysLeft === null
      ? `Endgültige Löschung deiner Organisation „${o.organizationName}“`
      : `Erinnerung: „${o.organizationName}“ wird ${inDays(o.daysLeft)} endgültig gelöscht`;
  const exportUrl = `${o.appUrl}/reports`;
  const intro = o.closedForInactivity
    ? `Deine Organisation „${o.organizationName}“ wurde am ${formatDate(o.deletedAt)} geschlossen, weil sie lange nicht genutzt wurde.`
    : `Deine Organisation „${o.organizationName}“ wurde am ${formatDate(o.deletedAt)} gelöscht.`;
  const what = `Ab dem ${formatDate(o.dueAt)}${o.daysLeft === null ? '' : ` (${inDays(o.daysLeft)})`} löschen wir ihre Daten endgültig: ${ORGANIZATION_DATA}.`;
  const contact = contactSentence(o.contactEmail);
  const plan = o.daysLeft === null ? REMINDER_PLAN : null;
  const html = rahmen({
    kontext: 'Konto',
    titel: `OpenEOS — ${subject}`,
    preheader: `Endgültige Löschung ab ${formatDate(o.dueAt)}`,
    empfaenger: o.to,
    appUrl: o.appUrl,
    inhalt: stapeln(
      ueberschrift(subject),
      absatz(intro),
      absatz(what),
      datenblock('Details', [
        ['Organisation', o.organizationName],
        [
          o.closedForInactivity ? 'Geschlossen am' : 'Gelöscht am',
          formatDate(o.deletedAt),
        ],
        ['Endgültig ab', formatDate(o.dueAt)],
      ]),
      hinweis('Daten jetzt exportieren', READ_ONLY_EXPORT),
      knopf(exportUrl, 'Daten exportieren'),
      ersatzlink(exportUrl),
      absatz(RESTORE_ORGANIZATION),
      absatz(FISCAL_NOTE),
      plan ? absatz(plan) : null,
      contact ? absatz(contact) : null,
    ),
  });
  const text = [
    intro,
    '',
    what,
    '',
    READ_ONLY_EXPORT,
    `Export: ${exportUrl}`,
    '',
    RESTORE_ORGANIZATION,
    '',
    FISCAL_NOTE,
    ...(plan ? ['', plan] : []),
    ...(contact ? ['', contact] : []),
  ].join('\n');
  return { subject, html, text };
}

/**
 * Ankuendigung: die (geloeschte bzw. geschlossene) Organisation wird
 * endgueltig geloescht. Sie ist zugleich die Erinnerung 30 Tage vorher.
 */
export function organizationDeletionMail(o: {
  to: string;
  appUrl: string;
  organizationName: string;
  deletedAt: Date;
  closedForInactivity: boolean;
  dueAt: Date;
  contactEmail: string | null;
}): RetentionMail {
  return organizationFinalDeletionMail({ ...o, daysLeft: null });
}

/** Erinnerung 10 Tage bzw. 1 Tag vor der endgueltigen Loeschung. */
export function organizationDeletionReminderMail(o: {
  to: string;
  appUrl: string;
  organizationName: string;
  deletedAt: Date;
  closedForInactivity: boolean;
  dueAt: Date;
  daysLeft: number;
  contactEmail: string | null;
}): RetentionMail {
  return organizationFinalDeletionMail(o);
}

/** Erinnerung vor der Schliessung wegen Inaktivitaet. */
export function organizationInactivityReminderMail(o: {
  to: string;
  appUrl: string;
  organizationName: string;
  dueAt: Date;
  daysLeft: number;
  exportPeriodDays: number;
}): RetentionMail {
  const subject = `Erinnerung: Deine Organisation „${o.organizationName}“ wird ${inDays(o.daysLeft)} geschlossen`;
  const exportUrl = `${o.appUrl}/reports`;
  const intro = `Wie angekündigt schließen wir deine Organisation „${o.organizationName}“ ab dem ${formatDate(o.dueAt)} (${inDays(o.daysLeft)}), weil es lange keine Buchung gab.`;
  const after = `Nach der Schließung ist sie noch ${o.exportPeriodDays} Tage nur lesend nutzbar, damit du alle Daten exportieren kannst. Danach löschen wir ${ORGANIZATION_DATA} endgültig.`;
  const keep =
    'Du willst OpenEOS weiter nutzen? Dann buche bis dahin eine Veranstaltung oder schreib uns über den Support-Chat im Kundenportal – dein Konto bleibt dann bestehen.';
  const html = rahmen({
    kontext: 'Konto',
    titel: `OpenEOS — ${subject}`,
    preheader: `Schließung ab ${formatDate(o.dueAt)}`,
    empfaenger: o.to,
    appUrl: o.appUrl,
    inhalt: stapeln(
      ueberschrift(subject),
      absatz(intro),
      datenblock('Details', [
        ['Organisation', o.organizationName],
        ['Schließung ab', formatDate(o.dueAt)],
      ]),
      absatz(keep),
      hinweis('Daten exportieren', after),
      knopf(exportUrl, 'Daten exportieren'),
      ersatzlink(exportUrl),
      absatz(FISCAL_NOTE),
    ),
  });
  const text = [
    intro,
    '',
    keep,
    '',
    after,
    `Export: ${exportUrl}`,
    '',
    FISCAL_NOTE,
  ].join('\n');
  return { subject, html, text };
}

function organizationList(names: string[]): string {
  return names.map((n) => `„${n}“`).join(', ');
}

const ACCOUNT_FISCAL =
  'Hast du Kassenvorgänge gebucht, bleibt dein Name als Bediener im Steuerarchiv der jeweiligen Organisation für die gesetzliche Frist von zehn Jahren erhalten.';

const CANCEL_ACCOUNT_DELETION =
  'Du hast es dir anders überlegt? Melde dich an und klicke im Hinweis oben auf der Seite auf „Löschung abbrechen“ – dein Konto und die Organisation bleiben dann bestehen.';

/**
 * Konto geloescht, Organisation(en) mit dem einzigen Mitglied: Konto und
 * Organisation werden gemeinsam endgueltig geloescht. Ohne `daysLeft` die
 * Bestaetigung direkt nach dem Loeschen (zugleich die Erinnerung 30 Tage
 * vorher), sonst eine Erinnerung.
 */
export function accountDeletionScheduledMail(o: {
  to: string;
  appUrl: string;
  organizations: string[];
  requestedAt: Date;
  dueAt: Date;
  daysLeft?: number | null;
}): RetentionMail {
  const reminder = o.daysLeft !== undefined && o.daysLeft !== null;
  const plural = o.organizations.length > 1;
  const orgs = organizationList(o.organizations);
  const subject = reminder
    ? `Erinnerung: Dein OpenEOS-Konto wird ${inDays(o.daysLeft!)} endgültig gelöscht`
    : `Dein OpenEOS-Konto wird am ${formatDate(o.dueAt)} gelöscht`;
  const exportUrl = `${o.appUrl}/reports`;
  const intro = `Du hast am ${formatDate(o.requestedAt)} dein Konto ${o.to} gelöscht. Weil du das einzige Mitglied von ${orgs} bist, ${plural ? 'werden diese Organisationen' : 'wird die Organisation'} mitgelöscht. Damit du ihre Daten noch exportieren kannst, löschen wir alles erst ab dem ${formatDate(o.dueAt)}${reminder ? ` (${inDays(o.daysLeft!)})` : ''} endgültig.`;
  const what = `Dann entfernen wir dein Konto (Name, E-Mail-Adresse, Anmeldedaten) und die Daten ${plural ? 'der Organisationen' : 'der Organisation'}: ${ORGANIZATION_DATA}.`;
  const until = `Bis dahin kannst du dich weiter anmelden. ${plural ? 'Die Organisationen sind' : 'Die Organisation ist'} nur noch lesend nutzbar: Exportiere, was du brauchst – Berichte als CSV oder PDF, Bestellungen, Kassenbuch und mit Cloud-TSE auch DSFinV-K- und TSE-Export. Neue Organisationen anlegen oder anderen beitreten kannst du nicht mehr.`;
  const plan = reminder ? null : REMINDER_PLAN;
  const html = rahmen({
    kontext: 'Konto',
    titel: `OpenEOS — ${subject}`,
    preheader: `Endgültige Löschung ab ${formatDate(o.dueAt)}`,
    empfaenger: o.to,
    appUrl: o.appUrl,
    inhalt: stapeln(
      ueberschrift(subject),
      absatz(intro),
      absatz(what),
      datenblock('Details', [
        ['Konto', o.to],
        [
          plural ? 'Organisationen' : 'Organisation',
          o.organizations.join(', '),
        ],
        ['Gelöscht am', formatDate(o.requestedAt)],
        ['Endgültig ab', formatDate(o.dueAt)],
      ]),
      hinweis('Daten jetzt exportieren', until),
      knopf(exportUrl, 'Daten exportieren'),
      ersatzlink(exportUrl),
      absatz(CANCEL_ACCOUNT_DELETION),
      absatz(FISCAL_NOTE),
      absatz(ACCOUNT_FISCAL),
      plan ? absatz(plan) : null,
    ),
  });
  const text = [
    intro,
    '',
    what,
    '',
    until,
    `Export: ${exportUrl}`,
    '',
    CANCEL_ACCOUNT_DELETION,
    '',
    FISCAL_NOTE,
    ACCOUNT_FISCAL,
    ...(plan ? ['', plan] : []),
  ].join('\n');
  return { subject, html, text };
}

/** Ankuendigung: ungenutztes Benutzerkonto ohne Organisation wird geloescht. */
export function userInactivityMail(o: {
  to: string;
  appUrl: string;
  inactiveMonths: number;
  dueAt: Date;
}): RetentionMail {
  const subject = 'Dein OpenEOS-Konto wird gelöscht';
  const loginUrl = `${o.appUrl}/login`;
  const intro = `Dein Konto ${o.to} gehört keiner Organisation mehr an und wurde seit mehr als ${o.inactiveMonths} Monaten nicht genutzt. Ab dem ${formatDate(o.dueAt)} löschen wir es mit deinem Namen, deiner E-Mail-Adresse und deinen Anmeldedaten.`;
  const keep =
    'Du willst dein Konto behalten? Dann melde dich bis dahin einfach einmal an.';
  const html = rahmen({
    kontext: 'Konto',
    titel: `OpenEOS — ${subject}`,
    preheader: `Löschung ab ${formatDate(o.dueAt)}`,
    empfaenger: o.to,
    appUrl: o.appUrl,
    inhalt: stapeln(
      ueberschrift(subject),
      absatz(intro),
      absatz(keep),
      knopf(loginUrl, 'Anmelden'),
      ersatzlink(loginUrl),
      absatz(
        'Hast du Kassenvorgänge gebucht, bleibt dein Name als Bediener im Steuerarchiv der jeweiligen Organisation für die gesetzliche Frist von zehn Jahren erhalten.',
      ),
    ),
  });
  const text = [intro, '', keep, `Anmelden: ${loginUrl}`].join('\n');
  return { subject, html, text };
}

/** Bestaetigung: Organisation auf Verlangen sofort endgueltig geloescht (AGB 10.4, AVV 10.5). */
export function organizationPurgedMail(o: {
  to: string;
  appUrl: string;
  organizationName: string;
  purgedAt: Date;
}): RetentionMail {
  const subject = `Deine Organisation „${o.organizationName}“ wurde endgültig gelöscht`;
  const intro = `Wie verlangt haben wir die Daten deiner Organisation „${o.organizationName}“ am ${formatDate(o.purgedAt)} endgültig gelöscht: Artikel, Einstellungen, Bestellungen, Schichtpläne, Geräte, Zugänge und Mitgliedschaften.`;
  const backups =
    'In unseren Datensicherungen sind die Daten noch bis zu acht Wochen enthalten; sie werden dort nicht mehr verarbeitet und laufen dann automatisch aus.';
  const html = rahmen({
    kontext: 'Konto',
    titel: `OpenEOS — ${subject}`,
    preheader: `Gelöscht am ${formatDate(o.purgedAt)}`,
    empfaenger: o.to,
    appUrl: o.appUrl,
    inhalt: stapeln(
      ueberschrift(subject),
      absatz(intro),
      datenblock('Details', [
        ['Organisation', o.organizationName],
        ['Endgültig gelöscht am', formatDate(o.purgedAt)],
      ]),
      absatz(backups),
      absatz(FISCAL_NOTE),
    ),
  });
  const text = [intro, '', backups, '', FISCAL_NOTE].join('\n');
  return { subject, html, text };
}

/** Code fuer „Konto löschen“ bei Konten ohne Passwort. */
export function accountDeletionCodeMail(o: {
  to: string;
  appUrl: string;
  code: string;
  validMinutes: number;
}): RetentionMail {
  const subject = 'Dein Code zum Löschen deines OpenEOS-Kontos';
  const intro = `Mit diesem Code bestätigst du, dass du dein Konto ${o.to} löschen willst. Er gilt ${o.validMinutes} Minuten.`;
  const ignore =
    'Du hast das nicht angefordert? Dann ignoriere diese E-Mail – dein Konto bleibt bestehen. Ändere zur Sicherheit dein Passwort bzw. melde dich ab.';
  const html = rahmen({
    kontext: 'Konto',
    titel: `OpenEOS — ${subject}`,
    preheader: `Code gültig für ${o.validMinutes} Minuten`,
    empfaenger: o.to,
    appUrl: o.appUrl,
    inhalt: stapeln(
      ueberschrift(subject),
      absatz(intro),
      codeBlock(o.code),
      absatz(ignore),
    ),
  });
  const text = [intro, '', o.code, '', ignore].join('\n');
  return { subject, html, text };
}

/** Bestaetigung: Benutzer hat sein Konto selbst geloescht. */
export function accountDeletedMail(o: {
  to: string;
  appUrl: string;
  deletedAt: Date;
  /**
   * Nach einer geplanten Loeschung: die Organisationen, die mit dem Konto
   * endgueltig geloescht wurden.
   */
  purgedOrganizations?: string[];
}): RetentionMail {
  const subject = 'Dein OpenEOS-Konto wurde gelöscht';
  const purged = o.purgedOrganizations ?? [];
  const intro =
    purged.length > 0
      ? `Wie angekündigt haben wir dein Konto ${o.to} am ${formatDate(o.deletedAt)} endgültig gelöscht. Name, E-Mail-Adresse, Anmeldedaten, Sitzungen und Mitgliedschaften sind entfernt; du kannst dich nicht mehr anmelden.`
      : `Du hast dein Konto ${o.to} am ${formatDate(o.deletedAt)} gelöscht. Name, E-Mail-Adresse, Anmeldedaten, Sitzungen und Mitgliedschaften sind entfernt; du kannst dich nicht mehr anmelden.`;
  const orgs =
    purged.length > 0
      ? `Mit deinem Konto haben wir die Daten von ${organizationList(purged)} endgültig gelöscht: ${ORGANIZATION_DATA}. ${FISCAL_NOTE}`
      : null;
  const fiscal = ACCOUNT_FISCAL;
  const backups =
    'In unseren Datensicherungen sind die Daten noch bis zu acht Wochen enthalten und laufen dann automatisch aus.';
  const html = rahmen({
    kontext: 'Konto',
    titel: `OpenEOS — ${subject}`,
    preheader: `Gelöscht am ${formatDate(o.deletedAt)}`,
    empfaenger: o.to,
    appUrl: o.appUrl,
    inhalt: stapeln(
      ueberschrift(subject),
      absatz(intro),
      orgs ? absatz(orgs) : null,
      absatz(fiscal),
      absatz(backups),
    ),
  });
  const text = [intro, '', orgs, orgs ? '' : null, fiscal, '', backups]
    .filter((line): line is string => line !== null)
    .join('\n');
  return { subject, html, text };
}
