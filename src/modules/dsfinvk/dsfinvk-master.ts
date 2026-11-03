import { appVersion } from '../../common/constants/app-version';
import type { Device } from '../../database/entities/device.entity';
import type { Organization } from '../../database/entities/organization.entity';
import type { TseUnit } from '../../database/entities/tse-unit.entity';
import { berlinTime, localParts } from '../tse/tse-dates';
import { clientIdForOrganization } from '../tse/tse-process-data';
import { BRAND, VAT_KEYS } from './dsfinvk-builder';
import type {
  DsfinvkMasterData,
  DsfinvkSettings,
  DsfinvkTerminal,
  DsfinvkTseUnit,
} from './dsfinvk-types';

/** ISO 3166 Alpha-2 → Alpha-3 (DACH, Nachbarn, EU; Rest leer). */
const ALPHA3: Record<string, string> = {
  DE: 'DEU',
  AT: 'AUT',
  CH: 'CHE',
  LI: 'LIE',
  LU: 'LUX',
  BE: 'BEL',
  NL: 'NLD',
  FR: 'FRA',
  IT: 'ITA',
  DK: 'DNK',
  PL: 'POL',
  CZ: 'CZE',
  ES: 'ESP',
  PT: 'PRT',
  SE: 'SWE',
  FI: 'FIN',
  NO: 'NOR',
  IE: 'IRL',
  GB: 'GBR',
  HU: 'HUN',
  SK: 'SVK',
  SI: 'SVN',
  HR: 'HRV',
  GR: 'GRC',
  RO: 'ROU',
  BG: 'BGR',
  EE: 'EST',
  LV: 'LVA',
  LT: 'LTU',
  MT: 'MLT',
  CY: 'CYP',
  US: 'USA',
};

export function alpha3(country: string | null | undefined): string {
  return ALPHA3[(country ?? '').toUpperCase()] ?? '';
}

/** Stammdaten fuer Steuer und Anschrift aus den Einstellungen der Organisation. */
export interface TaxMasterData {
  legalName: string;
  street: string;
  zip: string;
  city: string;
  taxNumber: string;
  vatId: string;
}

type SettingsLike = Record<string, unknown> & {
  contact?: { address?: string; zipCode?: string; city?: string };
  address?: { street?: string; zip?: string; city?: string };
  taxNumber?: string;
  vatId?: string;
  legalName?: string;
  dsfinvk?: { tipRecipient?: string };
};

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function taxMasterData(
  org: Pick<Organization, 'name' | 'settings'>,
): TaxMasterData {
  const s = (org.settings ?? {}) as unknown as SettingsLike;
  return {
    legalName: text(s.legalName) || org.name,
    street: text(s.contact?.address) || text(s.address?.street),
    zip: text(s.contact?.zipCode) || text(s.address?.zip),
    city: text(s.contact?.city) || text(s.address?.city),
    taxNumber: text(s.taxNumber),
    vatId: text(s.vatId).replace(/\s+/g, '').toUpperCase(),
  };
}

/** Was fuer Stamm_Abschluss fehlt (leer = vollstaendig). */
export function missingMasterData(org: {
  name?: string;
  settings: Organization['settings'] | null;
}): string[] {
  const m = taxMasterData({
    name: org.name ?? '',
    settings: org.settings as Organization['settings'],
  });
  const missing: string[] = [];
  if (!m.taxNumber && !m.vatId) missing.push('taxNumber');
  if (!m.street) missing.push('street');
  if (!m.zip) missing.push('zip');
  if (!m.city) missing.push('city');
  return missing;
}

export function dsfinvkSettings(
  org: Pick<Organization, 'settings'>,
): DsfinvkSettings {
  const s = (org.settings ?? {}) as unknown as SettingsLike;
  return {
    vatExempt:
      (org.settings as { vatExempt?: boolean } | null)?.vatExempt !== false,
    tipRecipient:
      s.dsfinvk?.tipRecipient === 'employee' ? 'employee' : 'employer',
  };
}

const DEVICE_MODELS: Record<string, string> = {
  pos: 'OpenEOS Kasse (Browser/App)',
  admin: 'OpenEOS Verwaltung',
  display: 'OpenEOS Anzeige',
  printer_agent: 'OpenEOS Drucker-Agent',
};

export function terminalOf(
  id: string,
  device: Pick<Device, 'name' | 'type'> | null,
): DsfinvkTerminal {
  return {
    id,
    brand: BRAND,
    model: device
      ? (DEVICE_MODELS[device.type] ?? 'OpenEOS Gerät')
      : 'OpenEOS Gerät (gelöscht)',
    serial: id,
    softwareBrand: BRAND,
    softwareVersion: appVersion(),
    name: device?.name ?? undefined,
  };
}

export function tseUnitOf(
  unit: Pick<
    TseUnit,
    | 'id'
    | 'serialNumber'
    | 'signatureAlgorithm'
    | 'logTimeFormat'
    | 'publicKey'
    | 'certificate'
  >,
): DsfinvkTseUnit {
  return {
    id: unit.id,
    serial: (unit.serialNumber ?? '').toLowerCase(),
    signatureAlgorithm: unit.signatureAlgorithm ?? 'ecdsa-plain-SHA256',
    logTimeFormat: unit.logTimeFormat ?? 'unixTime',
    publicKey: unit.publicKey ?? '',
    certificate: unit.certificate ?? '',
  };
}

export function masterData(
  org: Pick<Organization, 'id' | 'name' | 'settings' | 'country'>,
  terminals: DsfinvkTerminal[],
  units: DsfinvkTseUnit[],
): DsfinvkMasterData {
  const m = taxMasterData(org);
  const country = alpha3(org.country);
  return {
    company: {
      name: m.legalName,
      street: m.street,
      zip: m.zip,
      city: m.city,
      country,
      taxNumber: m.taxNumber,
      vatId: m.vatId,
    },
    // Betriebsstaette = Sitz der Organisation (mobile Kassen, BMF-FAQ Mitteilung 7).
    location: {
      name: org.name,
      street: m.street,
      zip: m.zip,
      city: m.city,
      country,
      vatId: m.vatId,
    },
    register: {
      id: clientIdForOrganization(org.id),
      brand: BRAND,
      model: 'OpenEOS Cloud-Kasse',
      softwareBrand: BRAND,
      softwareVersion: appVersion(),
      baseCurrency: (
        (org.settings as { currency?: string } | null)?.currency || 'EUR'
      ).toUpperCase(),
    },
    terminals,
    tseUnits: units,
    vatKeys: VAT_KEYS,
  };
}

// ---------------------------------------------------------------- Daten

export function businessDayStartHour(): number {
  const raw = Number(process.env.BUSINESS_DAY_START_HOUR);
  return Number.isInteger(raw) && raw >= 1 && raw <= 23 ? raw : 6;
}

function addDays(dateText: string, days: number): string {
  const [y, m, d] = dateText.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

/** Geschaeftstag (`YYYY-MM-DD`, Berlin, Wechsel um `startHour` Uhr) eines Zeitpunkts. */
export function businessDateOf(
  at: Date,
  startHour = businessDayStartHour(),
): string {
  const p = localParts(at);
  const calendar = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  return p.hour < startHour ? addDays(calendar, -1) : calendar;
}

/** Beginn und Ende (exklusiv) eines Geschaeftstags. */
export function businessDayRange(
  businessDate: string,
  startHour = businessDayStartHour(),
): { from: Date; to: Date } {
  const [y, m, d] = businessDate.split('-').map(Number);
  const next = addDays(businessDate, 1).split('-').map(Number);
  return {
    from: berlinTime(y, m, d, startHour),
    to: berlinTime(next[0], next[1], next[2], startHour),
  };
}

export function isBusinessDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}
