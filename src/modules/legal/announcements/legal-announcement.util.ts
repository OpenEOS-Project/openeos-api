import {
  isAfterInitialVersion,
  LEGAL_DOCUMENT_KEYS,
  type LegalDocumentKey,
} from '../../../config/legal.config';

/**
 * Ankuendigung neuer Fassungen der Rechtstexte — reine Regeln ohne
 * Datenbank: welche Fassung gilt, was eine Ankuendigung erfuellen muss.
 *
 * Welche Fassung gilt („aktuelle Fassung“)
 * ----------------------------------------
 * Je Dokument die neuere von
 *   a) der Fassung im Code bzw. aus `LEGAL_*_VERSION` und
 *   b) der neuesten angekuendigten Fassung, deren Datum erreicht ist
 *      (Tag in Europe/Berlin).
 * So wird eine angekuendigte Fassung an ihrem Tag ohne Deploy aktuell —
 * Annahme bei Buchung, Links und die erneute Annahme richten sich ab dann
 * nach ihr. Dass die Datei auf der Website liegt, wird beim Ankuendigen
 * geprueft (HEAD auf `/<pfad>/<fassung>`). Die Konstante im Code kann
 * spaeter nachgezogen werden; vor dem Datum anheben darf man sie nicht —
 * sie gilt sofort.
 */

/** Mindestfrist fuer AGB, Anlage 1 und AVV (AGB 13.4): sechs Wochen. */
export const LEGAL_NOTICE_DAYS = 42;

/**
 * Mindestfrist, wenn sich vom AVV nur Anhang B (Unterauftragsverarbeiter)
 * oder Anhang C (technische und organisatorische Massnahmen) aendert: vier
 * Wochen (AVV Ziffer 6.3, ueber 12.4 auch fuer Anhang C angewandt).
 */
export const AVV_ANNEX_NOTICE_DAYS = 28;

/** Dokumente, die Vertragsbestandteil sind (Frist, Widerspruchsrecht). */
export const CONTRACT_DOCUMENTS: readonly LegalDocumentKey[] = [
  'agb',
  'anlage1',
  'avv',
];

export const SUMMARY_MIN_LENGTH = 10;
export const SUMMARY_MAX_LENGTH = 4000;

const VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Was der Mechanismus von einer Ankuendigung wissen muss. */
export interface AnnouncedVersion {
  documents: readonly LegalDocumentKey[];
  version: string;
}

/** Heutiges Datum in Europe/Berlin als JJJJ-MM-TT. */
export function berlinToday(now: Date = new Date()): string {
  // en-CA formatiert als JJJJ-MM-TT.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** JJJJ-MM-TT plus Tage (Kalendertage, ohne Zeitzone). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Echtes Kalenderdatum im Format JJJJ-MM-TT? */
export function isValidVersion(version: unknown): version is string {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    return false;
  }
  const [y, m, d] = version.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

/** Neueste angekuendigte Fassung je Dokument (egal ob schon in Kraft). */
export function latestAnnounced(
  announcements: readonly AnnouncedVersion[],
): Partial<Record<LegalDocumentKey, string>> {
  const result: Partial<Record<LegalDocumentKey, string>> = {};
  for (const a of announcements) {
    for (const doc of a.documents) {
      const known = result[doc];
      if (!known || a.version > known) result[doc] = a.version;
    }
  }
  return result;
}

/**
 * Geltende Fassungen: Code/Umgebung oder die neueste angekuendigte Fassung,
 * deren Tag erreicht ist — die jeweils neuere.
 */
export function effectiveLegalVersions(
  base: Record<LegalDocumentKey, string>,
  announcements: readonly AnnouncedVersion[],
  today: string,
): Record<LegalDocumentKey, string> {
  const inForce = latestAnnounced(
    announcements.filter((a) => a.version <= today),
  );
  const result = { ...base };
  for (const doc of LEGAL_DOCUMENT_KEYS) {
    const announced = inForce[doc];
    if (announced && announced > result[doc]) result[doc] = announced;
  }
  return result;
}

export interface AnnouncementInput {
  documents: readonly string[];
  version: string;
  summaryDe: string;
  summaryEn?: string | null;
  shortNotice?: boolean;
  explicitConsent?: boolean;
  /**
   * Vom AVV aendern sich nur die Anhaenge B/C: keine Zustimmung noetig,
   * Information vier Wochen vorher mit Widerspruchsrecht (AVV 6.3, 12.4).
   */
  avvAnnexesOnly?: boolean;
}

export interface AnnouncementContext {
  /** Heute (Europe/Berlin), JJJJ-MM-TT. */
  today: string;
  /** Geltende Fassungen. */
  current: Record<LegalDocumentKey, string>;
  initialVersion: string;
  /** Schon angekuendigte Fassungen (auch kuenftige). */
  announced: readonly AnnouncedVersion[];
}

export interface AnnouncementProblem {
  field:
    | 'documents'
    | 'version'
    | 'summaryDe'
    | 'summaryEn'
    | 'website'
    | 'explicitConsent'
    | 'avvAnnexesOnly';
  message: string;
  document?: LegalDocumentKey;
}

const DOCUMENT_NAMES: Record<LegalDocumentKey, string> = {
  agb: 'AGB',
  anlage1: 'Anlage 1 (Leistungsbeschreibung und Preisliste)',
  avv: 'Auftragsverarbeitungsvertrag',
  privacy: 'Datenschutzerklärung',
  imprint: 'Impressum',
};

/** „15.01.2027“ fuer Fehlermeldungen. */
function shortDate(version: string): string {
  const [y, m, d] = version.split('-');
  return `${d}.${m}.${y}`;
}

/**
 * Prueft eine Ankuendigung ohne Netz und Datenbank. Leer = in Ordnung.
 *
 * - mindestens ein Dokument, keine unbekannten;
 * - Fassung ist ein Datum nach heute, nach der Ausgangsfassung und nach der
 *   geltenden und jeder schon angekuendigten Fassung jedes Dokuments;
 * - AGB, Anlage 1 und AVV: mindestens sechs Wochen im Voraus, ausser bei
 *   gesetzlich veranlassten Aenderungen (`shortNotice`);
 * - AVV: Aenderungen brauchen die Zustimmung des Kunden in Textform (AVV
 *   Ziffer 12.4) — also `explicitConsent`, ausser es aendern sich nur die
 *   Anhaenge B/C (`avvAnnexesOnly`, Verfahren nach AVV Ziffer 6.3); dann
 *   reichen vier Wochen;
 * - Zusammenfassung auf Deutsch (10–4000 Zeichen), Englisch optional.
 */
export function validateAnnouncement(
  input: AnnouncementInput,
  context: AnnouncementContext,
): AnnouncementProblem[] {
  const problems: AnnouncementProblem[] = [];
  const unknown = input.documents.filter(
    (d) => !LEGAL_DOCUMENT_KEYS.includes(d as LegalDocumentKey),
  );
  const documents = LEGAL_DOCUMENT_KEYS.filter((d) =>
    input.documents.includes(d),
  );
  if (unknown.length) {
    problems.push({
      field: 'documents',
      message: `Unbekannte Dokumente: ${unknown.join(', ')}.`,
    });
  }
  if (!documents.length) {
    problems.push({
      field: 'documents',
      message: 'Wähle mindestens ein Dokument.',
    });
  }

  const version = input.version?.trim();
  if (!isValidVersion(version)) {
    problems.push({
      field: 'version',
      message: 'Das Datum der neuen Fassung fehlt oder ist ungültig.',
    });
  } else {
    if (version <= context.today) {
      problems.push({
        field: 'version',
        message:
          'Die neue Fassung muss in der Zukunft in Kraft treten (frühestens morgen).',
      });
    }
    if (!isAfterInitialVersion(version, context.initialVersion)) {
      problems.push({
        field: 'version',
        message: `Fassungen bis ${shortDate(context.initialVersion)} sind die Ausgangsfassung und werden nicht angekündigt.`,
      });
    }
    const announced = latestAnnounced(context.announced);
    for (const doc of documents) {
      const current = context.current[doc];
      if (version <= current) {
        problems.push({
          field: 'version',
          document: doc,
          message: `${DOCUMENT_NAMES[doc]}: Die Fassung vom ${shortDate(current)} gilt schon — die neue muss später liegen.`,
        });
      }
      const pending = announced[doc];
      if (pending && version <= pending && pending > current) {
        problems.push({
          field: 'version',
          document: doc,
          message: `${DOCUMENT_NAMES[doc]}: Die Fassung vom ${shortDate(pending)} ist schon angekündigt — die neue muss später liegen.`,
        });
      }
    }
    const annexesOnly = input.avvAnnexesOnly === true;
    const sixWeeks = documents.filter(
      (d) => CONTRACT_DOCUMENTS.includes(d) && !(d === 'avv' && annexesOnly),
    );
    const earliest = addDays(context.today, LEGAL_NOTICE_DAYS);
    if (sixWeeks.length && !input.shortNotice && version < earliest) {
      problems.push({
        field: 'version',
        message: `${sixWeeks
          .map((d) => DOCUMENT_NAMES[d])
          .join(
            ', ',
          )} müssen mindestens sechs Wochen vorher angekündigt werden — frühestens zum ${shortDate(earliest)}. Kürzer nur bei gesetzlich oder behördlich veranlassten Änderungen (Option „Kürzere Frist“).`,
      });
    }
    const earliestAnnex = addDays(context.today, AVV_ANNEX_NOTICE_DAYS);
    if (
      annexesOnly &&
      documents.includes('avv') &&
      !input.shortNotice &&
      version < earliestAnnex
    ) {
      problems.push({
        field: 'version',
        document: 'avv',
        message: `Änderungen der Anhänge B/C des Auftragsverarbeitungsvertrags müssen mindestens vier Wochen vorher angekündigt werden (AVV Ziffer 6.3) — frühestens zum ${shortDate(earliestAnnex)}.`,
      });
    }
  }

  if (input.avvAnnexesOnly && !documents.includes('avv')) {
    problems.push({
      field: 'avvAnnexesOnly',
      message:
        '„Nur Anhang B/C geändert“ gibt es nur zusammen mit dem Auftragsverarbeitungsvertrag.',
    });
  }
  if (
    documents.includes('avv') &&
    !input.avvAnnexesOnly &&
    !input.explicitConsent
  ) {
    problems.push({
      field: 'explicitConsent',
      document: 'avv',
      message:
        'Änderungen des Auftragsverarbeitungsvertrags werden nur mit Zustimmung des Kunden in Textform wirksam (AVV Ziffer 12.4). Wähle „Ausdrückliche Zustimmung“ – oder „Nur Anhang B/C geändert“, wenn sich nur die Unterauftragsverarbeiter (Anhang B) oder die technischen und organisatorischen Maßnahmen (Anhang C) ändern.',
    });
  }

  const summaryDe = input.summaryDe?.trim() ?? '';
  if (summaryDe.length < SUMMARY_MIN_LENGTH) {
    problems.push({
      field: 'summaryDe',
      message: 'Beschreibe kurz auf Deutsch, was sich ändert.',
    });
  } else if (summaryDe.length > SUMMARY_MAX_LENGTH) {
    problems.push({
      field: 'summaryDe',
      message: `Die Zusammenfassung darf höchstens ${SUMMARY_MAX_LENGTH} Zeichen lang sein.`,
    });
  }
  if ((input.summaryEn?.trim().length ?? 0) > SUMMARY_MAX_LENGTH) {
    problems.push({
      field: 'summaryEn',
      message: `Die englische Zusammenfassung darf höchstens ${SUMMARY_MAX_LENGTH} Zeichen lang sein.`,
    });
  }
  return problems;
}
