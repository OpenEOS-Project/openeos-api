import type { Organization } from '../../database/entities/organization.entity';
import { missingMasterData } from '../dsfinvk/dsfinvk-master';

/**
 * Pflichtangaben beim Kauf einer Veranstaltung (Entscheidung 2026-11-04):
 * Die Registrierung bleibt schlank; erst beim Freischalten fragt der Dialog,
 * was fehlt — immer offizieller Name und Rechnungsanschrift, bei deutschen
 * Organisationen mit Cloud-TSE zusaetzlich Steuernummer oder USt-IdNr.
 * (dieselben Felder wie Einstellungen → Steuerangaben, dieselbe Regel wie
 * `TSE_MASTER_DATA_REQUIRED`).
 */
export type PurchaseMasterDataField =
  | 'legalName'
  | 'street'
  | 'zip'
  | 'city'
  | 'taxNumber'
  | 'vatId';

export interface PurchaseMasterDataValues {
  legalName: string;
  street: string;
  zip: string;
  city: string;
  taxNumber: string;
  vatId: string;
}

type OrgLike = Pick<Organization, 'name' | 'country' | 'settings'> & {
  billingAddress: Organization['billingAddress'];
};

type SettingsLike = {
  legalName?: unknown;
  taxNumber?: unknown;
  vatId?: unknown;
  contact?: { address?: unknown; zipCode?: unknown; city?: unknown };
  address?: { street?: unknown; zip?: unknown; city?: unknown };
};

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** USt-IdNr. ohne Leerzeichen, in Grossbuchstaben (wie gespeichert). */
export function normalizeVatId(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

/** USt-IdNr.: DE + 9 Ziffern; andere Laender: 2 Buchstaben + 2–13 Zeichen. */
export function isValidVatId(value: string): boolean {
  const vat = normalizeVatId(value);
  if (!vat) return false;
  if (vat.startsWith('DE')) return /^DE\d{9}$/.test(vat);
  return /^[A-Z]{2}[0-9A-Z]{2,13}$/.test(vat);
}

/**
 * Deutsche Steuernummer: Ziffern mit Schraegstrichen, Leerzeichen oder
 * Bindestrichen, 10–13 Ziffern (Laenderformat 10/11, bundeseinheitlich 13).
 */
export function isValidTaxNumber(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || !/^[0-9/\s-]+$/.test(trimmed)) return false;
  const digits = trimmed.replace(/\D/g, '').length;
  return digits >= 10 && digits <= 13;
}

/**
 * Die Werte, die der Dialog vorbelegt. Offizieller Name: Steuerangaben,
 * sonst der Rechnungsempfaenger einer frueheren Bestellung auf Rechnung.
 * Anschrift: Rechnungsanschrift, sonst die Anschrift der Organisation.
 */
export function purchaseMasterDataOf(org: OrgLike): PurchaseMasterDataValues {
  const s = (org.settings ?? {}) as SettingsLike;
  const billing = org.billingAddress;
  return {
    legalName:
      text(s.legalName) || text(billing?.company) || text(billing?.name),
    street:
      text(billing?.street) ||
      text(s.contact?.address) ||
      text(s.address?.street),
    zip: text(billing?.zip) || text(s.contact?.zipCode) || text(s.address?.zip),
    city: text(billing?.city) || text(s.contact?.city) || text(s.address?.city),
    taxNumber: text(s.taxNumber),
    vatId: normalizeVatId(text(s.vatId)),
  };
}

/**
 * Was vor dem Kauf fehlt. `withTse`: die Freischaltung bringt die
 * Cloud-TSE mit (DE, „Alle Funktionen“ oder Bestand mit „Ja“) — dann auch
 * Steuernummer/USt-IdNr. (Format DE) und die Anschrift der Organisation
 * (DSFinV-K-Stammdaten).
 */
export function missingPurchaseMasterData(
  org: OrgLike,
  options: { withTse: boolean },
): PurchaseMasterDataField[] {
  const s = (org.settings ?? {}) as SettingsLike;
  const billing = org.billingAddress;
  const legalName =
    text(s.legalName) || text(billing?.company) || text(billing?.name);
  const missing = new Set<PurchaseMasterDataField>();
  if (!legalName) missing.add('legalName');
  if (!text(billing?.street)) missing.add('street');
  if (!text(billing?.zip)) missing.add('zip');
  if (!text(billing?.city)) missing.add('city');

  if (options.withTse) {
    for (const field of missingMasterData({
      name: org.name,
      settings: org.settings,
    })) {
      if (field !== 'taxNumber') missing.add(field as PurchaseMasterDataField);
    }
    const taxNumber = text(s.taxNumber);
    const vatId = normalizeVatId(text(s.vatId));
    const german = (org.country ?? 'DE').toUpperCase() === 'DE';
    const taxOk = taxNumber && (!german || isValidTaxNumber(taxNumber));
    const vatOk = vatId && isValidVatId(vatId);
    if (!taxOk && !vatOk) missing.add('taxNumber');
    if (vatId && !vatOk) missing.add('vatId');
  }
  const order: PurchaseMasterDataField[] = [
    'legalName',
    'street',
    'zip',
    'city',
    'taxNumber',
    'vatId',
  ];
  return order.filter((field) => missing.has(field));
}
