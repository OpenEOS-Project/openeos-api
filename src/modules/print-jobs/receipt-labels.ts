import type { OrganizationSettings } from '../../database/entities/organization.entity';

/**
 * Zahlart auf Bon und Gegenbeleg. Der Bon ist deutsch (wie die
 * Vorlagen); der Druckauftrag traegt daneben weiter den Rohwert
 * `payment_method`, damit eigene Vorlagen danach verzweigen koennen.
 */
export const PAYMENT_LABELS: Readonly<Record<string, string>> = {
  cash: 'Bar',
  card: 'Karte',
  sumup_terminal: 'Karte (SumUp)',
  sumup_online: 'Online (SumUp)',
  paypal: 'PayPal',
  google_pay: 'Google Pay',
  apple_pay: 'Apple Pay',
  tokens: 'Wertmarken',
};

/** Anzeigename einer Zahlart; Unbekanntes bleibt wie geliefert. */
export function paymentMethodLabel(
  method: string | null | undefined,
): string | undefined {
  if (!method) return undefined;
  return PAYMENT_LABELS[method] ?? method;
}

/**
 * Anschrift im Bonkopf: „Straße, PLZ Ort“ aus den vorhandenen Teilen.
 * Fehlende oder leere Teile fallen weg (keine „undefined“ und keine
 * verwaisten Kommas); ohne jeden Teil `undefined`, dann druckt die Vorlage
 * keine Zeile.
 */
export function formatOrganizationAddress(
  address:
    | Partial<NonNullable<OrganizationSettings['address']>>
    | null
    | undefined,
): string | undefined {
  if (!address || typeof address !== 'object') return undefined;
  const part = (value: unknown) =>
    typeof value === 'string' || typeof value === 'number'
      ? String(value).trim()
      : '';
  const street = part(address.street);
  const place = [part(address.zip), part(address.city)]
    .filter(Boolean)
    .join(' ');
  const text = [street, place].filter(Boolean).join(', ');
  return text || undefined;
}

/** `organization`-Block im Druckauftrag (Kopf von Bon und Gegenbeleg). */
export function organizationPrintBlock(org: {
  name: string;
  settings?: Partial<OrganizationSettings> | null;
}): { name: string; address?: string; phone?: string } {
  const phone = org.settings?.contact?.phone?.trim();
  return {
    name: org.name,
    address: formatOrganizationAddress(org.settings?.address),
    phone: phone || undefined,
  };
}
