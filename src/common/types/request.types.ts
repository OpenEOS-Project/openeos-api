import type { Request } from 'express';
import type { Device } from '../../database/entities';
import type { RequestUser } from '../decorators/current-user.decorator';

/**
 * Das Express-Objekt, wie es nach den Guards aussieht.
 *
 * Guards haengen unterwegs Felder an die Anfrage (Benutzer, Geraet,
 * Organisation). Express kennt sie nicht, also waren sie bisher `any` — ein
 * umbenanntes Feld fiel erst zur Laufzeit als `undefined` auf. Hier stehen sie
 * an einer Stelle, und `getRequest<AppRequest>()` macht sie ueberall bekannt.
 */
export interface AppRequest extends Request {
  user?: RequestUser;
  device?: Device;
  organizationId?: string;
  apiTokenScopes?: string[];
}
