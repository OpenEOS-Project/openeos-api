import { SetMetadata } from '@nestjs/common';

export const REVEAL_SECRETS_KEY = 'revealSecrets';

/**
 * Gibt einzelne sonst geschwaerzte Felder fuer genau diese Antwort frei
 * (siehe SECRET_FIELDS in response-redaction.util.ts).
 *
 * Nur fuer Antworten, die ein Geheimnis einmalig an den liefern, der es
 * braucht: das Zugangstoken an das Geraet, das sich gerade anmeldet, die
 * neu vergebene PIN an den, der sie vergeben hat. Lesende Endpunkte
 * bekommen diese Freigabe nie.
 */
export const RevealSecrets = (...fields: string[]) =>
  SetMetadata(REVEAL_SECRETS_KEY, fields);
