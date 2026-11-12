/**
 * Felder, die keine Organisations-Antwort traegt — unabhaengig davon, wie
 * das Entity geladen wurde: die Support-PIN, Stripe-Kennungen und
 * mitgeladene Relationen (Mitglieder samt Konten, Geraete, Bestellungen …).
 * Mitglieder gibt es nur ueber `GET /organizations/:id/members` mit
 * Mitgliederrecht.
 */
export const ORGANIZATION_HIDDEN_FIELDS = [
  'supportPin',
  'stripeCustomerId',
  'stripeSubscriptionId',
  'userOrganizations',
  'events',
  'devices',
  'printers',
  'printTemplates',
  'orders',
  'qrCodes',
  'invitations',
  'invoices',
] as const;

/** Kopie ohne die verborgenen Felder. */
export function withoutHiddenOrganizationFields<T extends object>(
  organization: T,
): Record<string, unknown> {
  const visible: Record<string, unknown> = {
    ...(organization as Record<string, unknown>),
  };
  for (const field of ORGANIZATION_HIDDEN_FIELDS) delete visible[field];
  return visible;
}
