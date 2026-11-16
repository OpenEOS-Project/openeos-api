import type { ConfigService } from '@nestjs/config';

import { TseConfig } from '../tse/tse.config';

/**
 * Einsatzbedingungen der Cloud-TSE (Umgebungsschutzkonzept des
 * TSE-Herstellers), die der Kunde einhalten muss. Den Text liefert Swissbit;
 * bis dahin zeigt „Rechtliches“ einen Platzhalter.
 *
 * Nur bei verfuegbarer Cloud-TSE (`available`) — im Modus „bald
 * verfuegbar“ und ohne TSE gibt es nichts anzuzeigen (`null`).
 * `TSE_CONDITIONS_URL`: Link auf das Dokument (http/https),
 * `TSE_CONDITIONS_TEXT`: kurzer Text dazu (Absaetze per Leerzeile).
 */
export interface TseConditions {
  url: string | null;
  text: string | null;
}

export function tseConditionsFrom(config: ConfigService): TseConditions | null {
  if (new TseConfig(config).availability !== 'available') return null;
  const url = (config.get<string>('TSE_CONDITIONS_URL') ?? '').trim();
  const text = (config.get<string>('TSE_CONDITIONS_TEXT') ?? '').trim();
  return {
    url: /^https?:\/\//i.test(url) ? url : null,
    text: text ? text.replace(/\\n/g, '\n').slice(0, 5000) : null,
  };
}
