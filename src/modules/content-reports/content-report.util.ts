import type {
  ContentReportAction,
  ContentReportReason,
} from '../../database/entities/content-report.entity';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCALES = new Set(['de', 'en']);
/** Unterseiten unter /s/, die keinen Schichtplan bezeichnen. */
const HELPER_RESERVED = new Set(['manage', 'verify', 'proposal']);

export type ReportTarget =
  | { kind: 'event'; eventId: string }
  | { kind: 'shift_plan'; slug: string }
  | null;

/**
 * Welche oeffentliche Seite die Fundstelle bezeichnet:
 * - Shop: `/<eventId>`, `/<eventId>/checkout`, `/<eventId>/legal/…`,
 *   `/widerruf/<eventId>`,
 * - Helferseite: `/s/<slug>` bzw. `/<locale>/s/<slug>`.
 *
 * Der Host spielt keine Rolle (Staging, eigene Installationen). Alles
 * andere bleibt `null`; die Meldung wird trotzdem angenommen.
 */
export function parseReportTarget(raw: string): ReportTarget {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => decodeURIComponent(s));
  if (segments.length && LOCALES.has(segments[0].toLowerCase())) {
    segments.shift();
  }
  if (segments.length === 0) return null;

  if (segments[0] === 's' && segments[1]) {
    const slug = segments[1];
    if (HELPER_RESERVED.has(slug) || slug.length > 100) return null;
    return { kind: 'shift_plan', slug };
  }
  if (segments[0] === 'widerruf' && segments[1] && UUID.test(segments[1])) {
    return { kind: 'event', eventId: segments[1].toLowerCase() };
  }
  if (UUID.test(segments[0])) {
    return { kind: 'event', eventId: segments[0].toLowerCase() };
  }
  return null;
}

export const REASON_LABELS: Record<ContentReportReason, string> = {
  illegal: 'Rechtswidriger Inhalt (allgemein)',
  intellectual_property: 'Urheber-, Marken- oder sonstige Schutzrechte',
  personal_rights: 'Persönlichkeitsrechte oder Datenschutz',
  consumer_protection: 'Verbraucherschutz oder irreführende Angaben',
  youth_protection: 'Jugendschutz (z. B. Alkohol, Tabak)',
  fraud: 'Betrug oder Fälschung',
  other: 'Sonstiges',
};

export const ACTION_LABELS: Record<ContentReportAction, string> = {
  none: 'Keine Maßnahme – der Inhalt bleibt unverändert online.',
  hide_content:
    'Der gemeldete Inhalt wurde entfernt bzw. ausgeblendet; die übrige Seite bleibt erreichbar.',
  disable_shop:
    'Die Seite wurde gesperrt (Shop abgeschaltet bzw. Helferseite nicht mehr veröffentlicht).',
};

/**
 * Rechtsbehelfe (Art. 17 Abs. 3 lit. f DSA), wenn der Super-Admin keinen
 * eigenen Text eintraegt. LUXCODE ist Hostingdiensteanbieter und als
 * Kleinstunternehmen von den Pflichten fuer Online-Plattformen (interne
 * Beschwerde nach Art. 20, Streitbeilegung nach Art. 21) ausgenommen
 * (Art. 19 DSA); eine erneute Pruefung bieten wir trotzdem an.
 */
export function defaultRedress(contactEmail: string | null): string {
  const contact = contactEmail
    ? `antworte auf diese E-Mail oder schreibe an ${contactEmail}`
    : 'antworte auf diese E-Mail';
  return `Wenn du mit der Entscheidung nicht einverstanden bist, ${contact} – wir prüfen sie dann noch einmal. Unabhängig davon kannst du gegen die Entscheidung den Rechtsweg zu den ordentlichen Gerichten beschreiten.`;
}

/** Zeilen der Begruendung (Art. 17 Abs. 3 DSA) bzw. der Mitteilung an den Meldenden. */
export function statementRows(input: {
  action: ContentReportAction | null;
  decision: string | null;
  facts: string | null;
  ground: string | null;
  redress: string;
  url: string;
  reportedAt: Date;
}): [string, string][] {
  const rows: [string, string][] = [
    ['Gemeldete Fundstelle', input.url],
    ['Eingang der Meldung', formatBerlin(input.reportedAt)],
    [
      'Entscheidung',
      input.decision?.trim() || 'Die Meldung wurde geprüft und abgeschlossen.',
    ],
    ['Maßnahme', input.action ? ACTION_LABELS[input.action] : '–'],
  ];
  if (input.facts?.trim()) rows.push(['Sachverhalt', input.facts.trim()]);
  if (input.ground?.trim()) {
    rows.push(['Rechtliche bzw. vertragliche Grundlage', input.ground.trim()]);
  }
  rows.push([
    'Automatisierte Mittel',
    'Die Entscheidung wurde von einem Menschen getroffen; automatisierte Mittel wurden nicht eingesetzt.',
  ]);
  rows.push(['Rechtsbehelfe', input.redress]);
  return rows;
}

export function formatBerlin(date: Date): string {
  return `${new Intl.DateTimeFormat('de-DE', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'Europe/Berlin',
  }).format(date)} Uhr`;
}
