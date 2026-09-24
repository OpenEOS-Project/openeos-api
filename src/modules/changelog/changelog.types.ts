export type ChangelogArt = 'neu' | 'verbessert' | 'behoben';

/** Ein Eintrag, zweisprachig — die Website zeigt beide Sprachen. */
export interface ChangelogEintrag {
  /** JJJJ-MM-TT. Zugleich die Ordnungsgroesse: was neuer ist, ist ungesehen. */
  datum: string;
  art: ChangelogArt;
  titel: { de: string; en: string };
  text: { de: string; en: string };
  /**
   * Eine Zeile fuer das Fenster beim Anmelden.
   *
   * Dort geht es um einen Ueberblick: Wer sich anmeldet, will wissen, was
   * es Neues gibt, und nicht fuenf Absaetze lesen. Der volle Text steht
   * auf der Website, wo Platz dafuer ist. Fehlt die Kurzfassung, faellt
   * das Fenster auf den vollen Text zurueck.
   */
  kurz?: { de: string; en: string };
}

/**
 * Ein Eintrag, wie ihn die API herausgibt: mit der Version, in der er
 * erschienen ist. Die steht nicht in den Daten selbst, sondern kommt aus
 * der Zuordnung Datum -> Version.
 */
export interface ChangelogEintragMitVersion extends ChangelogEintrag {
  version: string | null;
}
