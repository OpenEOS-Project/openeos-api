import type { LegalDocumentKey } from '../../../config/legal.config';
import {
  absatz,
  datenblock,
  escapeHtml,
  fussnote,
  hinweis,
  linkliste,
  rahmen,
  stapeln,
  ueberschrift,
  zitat,
  zwischentitel,
} from '../../email/email-template';
import { CONTRACT_DOCUMENTS } from './legal-announcement.util';

/** Namen der Dokumente in Mail und Betreff. */
export const ANNOUNCEMENT_DOCUMENT_LABELS: Record<LegalDocumentKey, string> = {
  agb: 'Allgemeine Geschäftsbedingungen (AGB)',
  anlage1: 'Anlage 1 zu den AGB – Leistungsbeschreibung und Preisliste',
  avv: 'Auftragsverarbeitungsvertrag (AVV)',
  privacy: 'Datenschutzerklärung',
  imprint: 'Impressum',
};

const SUBJECT_LABELS: Record<LegalDocumentKey, string> = {
  agb: 'AGB',
  anlage1: 'Leistungsbeschreibung und Preisliste',
  avv: 'Auftragsverarbeitungsvertrag',
  privacy: 'Datenschutzerklärung',
  imprint: 'Impressum',
};

export interface AnnouncementMailDocument {
  document: LegalDocumentKey;
  /** Neue Fassung auf der Website und als PDF. */
  versionUrl: string;
  pdfUrl: string;
  /** Bisher geltende Fassung. */
  previousVersion: string | null;
  previousUrl: string | null;
}

export interface AnnouncementMailInput {
  to: string;
  firstName: string | null;
  version: string;
  documents: AnnouncementMailDocument[];
  summaryDe: string;
  summaryEn: string | null;
  shortNotice: boolean;
  explicitConsent: boolean;
  /** Vom AVV aendern sich nur die Anhaenge B/C (AVV Ziffer 6.3, 12.4). */
  avvAnnexesOnly: boolean;
  /** Adresse fuer Widerspruch und Fragen (hello@openeos.de). */
  contactEmail: string;
  appUrl: string;
}

/** „die Änderungen der AGB“ — fuer Hinweise, die nur einen Teil betreffen. */
const GENITIV: Record<LegalDocumentKey, string> = {
  agb: 'der AGB',
  anlage1: 'der Anlage 1 (Leistungsbeschreibung und Preisliste)',
  avv: 'des Auftragsverarbeitungsvertrags',
  privacy: 'der Datenschutzerklärung',
  imprint: 'des Impressums',
};

/** 2027-01-15 → 15. Januar 2027 */
export function fassungsdatum(version: string): string {
  const [y, m, d] = version.split('-').map(Number);
  if (!y || !m || !d) return version;
  return new Intl.DateTimeFormat('de-DE', {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** „AGB, Auftragsverarbeitungsvertrag und Impressum“ */
function aufzaehlung(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} und ${items[items.length - 1]}`;
}

export function announcementSubject(
  documents: readonly LegalDocumentKey[],
  version: string,
): string {
  return `Neue Fassung: ${aufzaehlung(documents.map((d) => SUBJECT_LABELS[d]))} ab ${fassungsdatum(version)}`;
}

/**
 * Ankuendigung einer neuen Fassung (AGB 13.4, AVV 12.4): was sich aendert,
 * ab wann, Links auf neue und bisherige Fassung — und bei Vertragstexten
 * gesondert der Hinweis auf Widerspruchsrecht und Folge des Schweigens
 * bzw. auf die noetige Zustimmung.
 *
 * Der Wortlaut der Hinweise folgt AGB Ziffer 13.4 und – wenn sich vom AVV
 * nur die Anhaenge B/C aendern – AVV Ziffern 6.3 und 6.4; aendern sie
 * sich, hier nachziehen. Andere Aenderungen des AVV brauchen die
 * Zustimmung (AVV 12.4, `explicitConsent`, siehe validateAnnouncement).
 */
export function legalAnnouncementMail(input: AnnouncementMailInput): {
  subject: string;
  html: string;
} {
  const docs = input.documents.map((d) => d.document);
  const subject = announcementSubject(docs, input.version);
  const datum = fassungsdatum(input.version);
  const contract = docs.some((d) => CONTRACT_DOCUMENTS.includes(d));
  const kontakt = `<a href="mailto:${escapeHtml(input.contactEmail)}">${escapeHtml(input.contactEmail)}</a>`;

  /* AVV nur Anhaenge B/C: eigenes Verfahren (AVV 6.3) statt AGB 13.4. */
  const avvAnnex = input.avvAnnexesOnly && docs.includes('avv');
  const agbArt = docs.filter(
    (d) => CONTRACT_DOCUMENTS.includes(d) && !(d === 'avv' && avvAnnex),
  );

  const zeilen: [string, string][] = input.documents.map((d) => {
    const neu =
      d.document === 'avv' && avvAnnex
        ? `Neu ab ${datum}, nur Anhang B/C`
        : `Neu ab ${datum}`;
    return [
      SUBJECT_LABELS[d.document],
      d.previousVersion
        ? `${neu} (bisher Fassung vom ${fassungsdatum(d.previousVersion)})`
        : neu,
    ];
  });

  const links = input.documents.flatMap((d) => {
    const label = ANNOUNCEMENT_DOCUMENT_LABELS[d.document];
    const entries = [
      {
        text: `${label} – neue Fassung`,
        url: d.versionUrl,
        hinweis: `Gilt ab ${datum}. Als PDF: ${d.pdfUrl}`,
      },
    ];
    if (d.previousUrl && d.previousVersion) {
      entries.push({
        text: `${label} – bisherige Fassung`,
        url: d.previousUrl,
        hinweis: `Fassung vom ${fassungsdatum(d.previousVersion)}, gilt bis zum Inkrafttreten der neuen.`,
      });
    }
    return entries;
  });

  const hinweise: string[] = [];
  if (contract && input.explicitConsent) {
    hinweise.push(
      hinweis(
        'Deine Zustimmung ist nötig',
        `Diese Änderungen werden für dein bestehendes Kundenkonto nur wirksam, wenn du ihnen ausdrücklich zustimmst. Ab dem ${escapeHtml(datum)} bitten wir dich beim Anmelden in der App darum; du kannst auch vorher in Textform zustimmen, z. B. per E-Mail an ${kontakt}. Stimmst du nicht zu, gelten für dein Kundenkonto die bisherigen Bedingungen weiter; der Vertrag kann dann nach den AGB bzw. dem Auftragsverarbeitungsvertrag gekündigt werden. Für Buchungen ab dem ${escapeHtml(datum)} gelten die neuen Fassungen.`,
        true,
      ),
    );
  } else {
    if (agbArt.length) {
      /* Kommt der AVV (Anhaenge) mit, sagen beide Hinweise, wofuer sie gelten. */
      const welche = avvAnnex
        ? `die Änderungen ${aufzaehlung(agbArt.map((d) => GENITIV[d]))}`
        : 'die Änderungen';
      hinweise.push(
        hinweis(
          avvAnnex
            ? `Dein Widerspruchsrecht: ${aufzaehlung(agbArt.map((d) => SUBJECT_LABELS[d]))}`
            : 'Dein Widerspruchsrecht',
          `Für dein bestehendes Kundenkonto gelten ${welche} als angenommen, wenn du ihnen nicht innerhalb von sechs Wochen nach Zugang dieser Mitteilung in Textform widersprichst, z. B. per E-Mail an ${kontakt}. Widersprichst du, wird der Vertrag zu den bisherigen Bedingungen fortgesetzt; LUXCODE kann ihn in diesem Fall mit einer Frist von einem Monat zum Monatsende kündigen. Den Vertrag über dein Kundenkonto kannst du außerdem jederzeit in Textform kündigen. Für Buchungen ab dem ${escapeHtml(datum)} gelten die neuen Fassungen.`,
          true,
        ),
      );
    }
    if (avvAnnex) {
      hinweise.push(
        hinweis(
          agbArt.length
            ? 'Dein Widerspruchsrecht: Auftragsverarbeitungsvertrag'
            : 'Dein Widerspruchsrecht',
          `Am Auftragsverarbeitungsvertrag ändern sich nur Anhang B (Unterauftragsverarbeiter) bzw. Anhang C (technische und organisatorische Maßnahmen); dafür gilt das Verfahren nach Ziffer 6.3 des Auftragsverarbeitungsvertrags. Du kannst der Änderung innerhalb von vier Wochen nach Zugang dieser Mitteilung in Textform widersprechen, z. B. per E-Mail an ${kontakt}. Widersprichst du nicht fristgerecht, gilt die Änderung als genehmigt. Widersprichst du, bemühen wir uns gemeinsam um eine einvernehmliche Lösung; gelingt sie nicht innerhalb von zwei Wochen nach deinem Widerspruch, kann jede Seite den Nutzungsvertrag mit einer Frist von einem Monat zum Monatsende kündigen (Ziffer 6.4). Im Voraus gezahlte Vergütung für die Zeit nach dem Vertragsende erstattet LUXCODE; bis dahin setzt LUXCODE einen neuen Unterauftragsverarbeiter für deine Daten nicht ein, soweit das technisch möglich ist.`,
          true,
        ),
      );
    }
  }

  const html = rahmen({
    kontext: 'Rechtstexte',
    titel: `OpenEOS — ${subject}`,
    preheader: `Ab dem ${datum} gelten neue Fassungen: ${aufzaehlung(docs.map((d) => SUBJECT_LABELS[d]))}. Hier steht, was sich ändert.`,
    empfaenger: input.to,
    appUrl: input.appUrl,
    inhalt: stapeln(
      ueberschrift('Wir passen unsere Rechtstexte an.') +
        absatz(
          `${input.firstName ? `Hallo ${input.firstName}, ab` : 'Ab'} dem ${datum} gelten neue Fassungen der folgenden Dokumente von OpenEOS. Wir sagen dir rechtzeitig vorher Bescheid, damit du sie in Ruhe lesen kannst.`,
        ),
      datenblock('Was sich ändert', zeilen),
      zwischentitel('Die Änderungen im Überblick') + zitat(input.summaryDe),
      input.summaryEn
        ? zwischentitel('Summary in English') +
            zitat(input.summaryEn) +
            fussnote('Only the German version of the legal texts is binding.')
        : null,
      linkliste('Zum Nachlesen', links),
      input.shortNotice && contract
        ? absatz(
            'Die Änderung ist gesetzlich oder behördlich veranlasst und tritt deshalb mit kürzerer Frist in Kraft.',
          )
        : null,
      ...hinweise,
      contract
        ? null
        : absatz('Du musst nichts tun – diese Mail dient deiner Information.'),
      absatz(
        `Fragen? Antworte einfach auf diese Mail oder schreib an ${kontakt}.`,
        true,
      ),
      fussnote(
        'Du bekommst diese Mail, weil du Admin einer Organisation bei OpenEOS bist. Mitteilungen zu Änderungen der Rechtstexte gehören zum Vertrag und lassen sich nicht abbestellen.',
      ),
    ),
  });

  return { subject, html };
}
