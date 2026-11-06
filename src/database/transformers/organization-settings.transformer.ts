import type { ValueTransformer } from 'typeorm';

import {
  decryptCredentialSettings,
  encryptCredentialSettings,
} from '../../common/services/integration-credentials.crypto';

/**
 * `organizations.settings`: Zugangsdaten der Zahlungsanbieter verschluesselt
 * in der Datenbank, im Code im Klartext.
 *
 * Damit bekommt jeder Lesepfad (SumUp-Kartenleser, Online-Checkout, Shop,
 * Erstattungen, PayPal) den Schluessel wie bisher, und die Maskierung der
 * Antworten (`****1234`) zeigt weiter die letzten Zeichen des echten
 * Schluessels. Rohe SQL-Abfragen sehen den verschluesselten Wert — die
 * schreiben aber nur gezielt andere Abschnitte (`jsonb_set`).
 *
 * Aenderungserkennung beim save(): TypeORM vergleicht jsonb-Spalten im
 * Klartext (vor `to`); unveraenderte Einstellungen werden also nicht bei
 * jedem Speichern neu verschluesselt und geschrieben.
 */
export const organizationSettingsTransformer = {
  to: (value: unknown): unknown => encryptCredentialSettings(value),
  from: (value: unknown): unknown => decryptCredentialSettings(value),
} satisfies ValueTransformer;
