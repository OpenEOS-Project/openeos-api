import type { ValueTransformer } from 'typeorm';

import {
  decryptCredentialSettings,
  encryptCredentialSettings,
} from '../../common/services/integration-credentials.crypto';
import { stripRemovedSettings } from '../../common/utils/removed-settings.util';

/**
 * `organizations.settings`: Zugangsdaten der Zahlungsanbieter verschluesselt
 * in der Datenbank, im Code im Klartext.
 *
 * Damit bekommt jeder Lesepfad (SumUp-Kartenleser, Online-Checkout, Shop,
 * Erstattungen) den Schluessel wie bisher, und die Maskierung der
 * Antworten (`****1234`) zeigt weiter die letzten Zeichen des echten
 * Schluessels. Rohe SQL-Abfragen sehen den verschluesselten Wert — die
 * schreiben aber nur gezielt andere Abschnitte (`jsonb_set`).
 *
 * Aenderungserkennung beim save(): TypeORM vergleicht jsonb-Spalten im
 * Klartext (vor `to`); unveraenderte Einstellungen werden also nicht bei
 * jedem Speichern neu verschluesselt und geschrieben.
 */
export const organizationSettingsTransformer = {
  to: (value: unknown): unknown =>
    encryptCredentialSettings(stripRemovedSettings(value)),
  from: (value: unknown): unknown =>
    stripRemovedSettings(decryptCredentialSettings(value)),
} satisfies ValueTransformer;
