export type ChangelogArt = 'neu' | 'verbessert' | 'behoben';

/** Ein Eintrag, zweisprachig — die Website zeigt beide Sprachen. */
export interface ChangelogEintrag {
  /** JJJJ-MM-TT. Zugleich die Ordnungsgroesse: was neuer ist, ist ungesehen. */
  datum: string;
  art: ChangelogArt;
  titel: { de: string; en: string };
  text: { de: string; en: string };
}

/**
 * Ein Eintrag, wie ihn die API herausgibt: mit der Version, in der er
 * erschienen ist. Die steht nicht in den Daten selbst, sondern kommt aus
 * der Zuordnung Datum -> Version.
 */
export interface ChangelogEintragMitVersion extends ChangelogEintrag {
  version: string | null;
}
