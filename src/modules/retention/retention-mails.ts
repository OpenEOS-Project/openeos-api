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

function contactLink(contactEmail: string | null, subject: string): string {
  return contactEmail
    ? `mailto:${contactEmail}?subject=${encodeURIComponent(subject)}`
    : '';
}

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

/** Ankuendigung: die (geloeschte bzw. geschlossene) Organisation wird endgueltig geloescht. */
export function organizationDeletionMail(o: {
  to: string;
  appUrl: string;
  organizationName: string;
  deletedAt: Date;
  closedForInactivity: boolean;
  dueAt: Date;
  contactEmail: string | null;
}): RetentionMail {
  const subject = `Endgültige Löschung deiner Organisation „${o.organizationName}“`;
  const intro = o.closedForInactivity
    ? `Deine Organisation „${o.organizationName}“ wurde am ${formatDate(o.deletedAt)} geschlossen, weil sie lange nicht genutzt wurde.`
    : `Deine Organisation „${o.organizationName}“ wurde am ${formatDate(o.deletedAt)} gelöscht.`;
  const what = `Ab dem ${formatDate(o.dueAt)} löschen wir ihre Daten endgültig: Artikel, Einstellungen, Bestellungen, Schichtpläne, Geräte, Zugänge und Mitgliedschaften.`;
  const exportText = o.contactEmail
    ? `Bis dahin kannst du einen Export deiner Daten anfordern oder die Löschung rückgängig machen lassen: Schreib uns an ${o.contactEmail}.`
    : 'Bis dahin kannst du beim Betreiber einen Export deiner Daten anfordern oder die Löschung rückgängig machen lassen.';
  const link = contactLink(
    o.contactEmail,
    `Datenexport: ${o.organizationName}`,
  );
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
      hinweis('Export anfordern', exportText),
      link ? knopf(link, 'Export anfordern') : null,
      absatz(FISCAL_NOTE),
    ),
  });
  const text = [intro, '', what, '', exportText, '', FISCAL_NOTE].join('\n');
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
  closedOrganizations: string[];
}): RetentionMail {
  const subject = 'Dein OpenEOS-Konto wurde gelöscht';
  const intro = `Du hast dein Konto ${o.to} am ${formatDate(o.deletedAt)} gelöscht. Name, E-Mail-Adresse, Anmeldedaten, Sitzungen und Mitgliedschaften sind entfernt; du kannst dich nicht mehr anmelden.`;
  const orgs =
    o.closedOrganizations.length > 0
      ? `Mit deinem Konto wurden diese Organisationen gelöscht, weil du ihr einziges Mitglied warst: ${o.closedOrganizations.map((n) => `„${n}“`).join(', ')}. Ihre Daten löschen wir nach Ablauf der Exportfrist endgültig.`
      : null;
  const fiscal =
    'Hast du Kassenvorgänge gebucht, bleibt dein Name als Bediener im Steuerarchiv der jeweiligen Organisation für die gesetzliche Frist von zehn Jahren erhalten.';
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
