import { SetMetadata } from '@nestjs/common';

export const SAAS_ONLY_KEY = 'saasOnly';

/**
 * Markiert einen Endpunkt (oder einen ganzen Controller) als Teil des
 * gehosteten Angebots.
 *
 * In einer eigenstaendigen Installation gibt es diese Funktionen nicht:
 * Abrechnung, Stripe, Miet-Hardware, mandantenuebergreifende Verwaltung.
 * Sie antworten dort mit 404 statt mit 403 — ein "verboten" waere die
 * falsche Auskunft, denn es fehlt nicht die Berechtigung, es fehlt die
 * Funktion.
 */
export const SaasOnly = () => SetMetadata(SAAS_ONLY_KEY, true);
