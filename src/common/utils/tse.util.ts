/**
 * Cloud-TSE der Organisation (technische Sicherheitseinrichtung, § 146a AO).
 *
 * Einzige Stelle, an der OpenEOS fragt, ob eine Organisation eine aktive,
 * zertifizierte TSE hat. In Deutschland haengt daran, ob die Betriebsart
 * `full` (mit Bargeld) waehlbar und wirksam ist (operating-mode.util.ts).
 *
 * Heute immer false: Die Anbindung der Swissbit Cloud-TSE folgt im
 * naechsten Schritt (betriebsarten-spec.md §5). Die TSE-Integration ersetzt
 * `tseStatus.isActive` — z. B. durch einen Blick auf eine von ihr gepflegte
 * Spalte, die `OPERATING_MODE_SELECT` dann mitlaedt. Alle Aufrufer (jede
 * Barzahlung, das Umschalten der Betriebsart, die Antworten an Oberflaeche
 * und Kasse) gehen ueber `hasActiveTse`, damit nichts weiter zu aendern ist.
 *
 * Tests setzen den Wert ueber `tseStatus.isActive` und stellen ihn danach
 * zurueck.
 */
export interface TseOrg {
  id?: string;
  country?: string | null;
}

export const tseStatus: {
  isActive: (org: TseOrg | null | undefined) => boolean;
} = {
  isActive: () => false,
};

/** Hat die Organisation eine aktive Cloud-TSE? (Heute: nie.) */
export function hasActiveTse(org: TseOrg | null | undefined): boolean {
  if (!org) return false;
  return tseStatus.isActive(org) === true;
}
