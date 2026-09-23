import { createHash } from 'crypto';

/**
 * Schlüssel, unter dem ein gesperrter Zugangstoken im Cache liegt.
 *
 * Gehasht abgelegt, weil die Einträge den Abmeldevorgang überdauern: wer
 * in den Cache sieht, soll daraus keine noch gültigen Token ablesen
 * können. Für den Zweck — „ist genau dieser Token gesperrt?" — genügt der
 * Hash vollständig.
 *
 * Eine Datei für beide Seiten, damit Schreiben (Abmelden) und Lesen
 * (Prüfung jeder Anfrage) nicht auseinanderlaufen.
 */
export function gesperrterTokenSchluessel(accessToken: string): string {
  return `blacklist:token:${createHash('sha256').update(accessToken).digest('hex')}`;
}
