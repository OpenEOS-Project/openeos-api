/**
 * Die Form der Kennzahlen.
 *
 * Bewusst getrennt von der Umsetzung, weil auf der anderen Seite ein
 * Monitor sitzt, der sich darauf verlässt: Was hier steht, ist eine
 * Zusage.
 *
 * Grundsatz für die `letzte`-Listen: höchstens zehn Einträge, neueste
 * zuerst, jeder mit `id`. Daran erkennt ein Monitor, was er schon
 * gemeldet hat — ohne die Zahlen zu vergleichen und zu raten.
 *
 * Und ein Grundsatz zum Inhalt: Hier gehen Zahlen hinaus, keine
 * Personen. Nachnamen nur als Anfangsbuchstabe, keine E-Mail-Adressen,
 * Nachrichten angerissen statt vollständig. Ein Überwachungszugang soll
 * erkennen lassen, DASS etwas passiert ist — wer dahintersteckt, steht
 * im Adminbereich hinter einer richtigen Anmeldung.
 */

/** Zeichen, nach denen eine Nachrichtenvorschau abgeschnitten wird. */
export const VORSCHAU_LAENGE = 80;

/** Wie viele Einträge eine `letzte`-Liste höchstens enthält. */
export const LISTEN_LAENGE = 10;

export interface NeuerNutzer {
  id: string;
  erstelltAm: string;
  vorname: string;
  /** Nur der Anfangsbuchstabe — der volle Name gehört nicht hier hinaus. */
  nachnameInitial: string;
  organisation: string | null;
  emailBestaetigt: boolean;
}

export interface NeueOrganisation {
  id: string;
  name: string;
  erstelltAm: string;
  billingMode: string;
}

export interface Freischaltung {
  id: string;
  name: string;
  organisation: string | null;
  billingStatus: string;
  /** Tatsächlich berechnet, nicht der Listenpreis. */
  preisEur: number | null;
  bezahltAm: string | null;
}

export interface Kontaktanfrage {
  id: string;
  erstelltAm: string;
  typ: string;
  name: string;
  organisation: string | null;
  /** Angerissen auf VORSCHAU_LAENGE Zeichen. */
  vorschau: string;
}

export interface Kennzahlen {
  /** Zeitpunkt der Erhebung — der Abrufer weiß so, wie frisch die Zahlen sind. */
  erhobenAm: string;

  organisationen: {
    gesamt: number;
    neuImMonat: number;
    letzte: NeueOrganisation[];
  };

  nutzer: {
    gesamt: number;
    aktiv: number;
    neuImMonat: number;
    letzte: NeuerNutzer[];
  };

  veranstaltungen: {
    gesamt: number;
    aktiv: number;
    imTest: number;
    bezahlt: number;
    /** Bezahlvorgang begonnen, aber nicht abgeschlossen. */
    pending: number;
    aufRechnung: number;
    erlassen: number;
    letzteFreischaltungen: Freischaltung[];
  };

  umsatz: {
    /** Was OpenEOS eingenommen hat, nicht der Umsatz der Kunden. */
    bezahlteVeranstaltungen: number;
    summeEur: number;
    heuteEur: number;
    monatEur: number;
    /** Hardware-Miete getrennt, weil sie anders zustande kommt. */
    mieteEur: number;
  };

  kontaktanfragen: {
    offen: number;
    neu24h: number;
    letzte: Kontaktanfrage[];
  };

  support: {
    ungelesen: number;
    threadsMitUngelesen: number;
    letzteNachrichtAm: string | null;
  };

  geraete: { gesamt: number; freigegeben: number };
  bestellungen: { gesamt: number; letzte24h: number };
}
