import type { Device } from '../../database/entities/device.entity';

/**
 * Was ein Geraet ueber die Geraete-API (`/device-api/…`) tun darf, je nach
 * Geraetetyp. Jeder Endpunkt dort nennt genau eine Faehigkeit
 * (`@DeviceCapability`); ohne Angabe lehnt der DeviceCapabilityGuard ab.
 */
export enum DeviceCapabilityName {
  /** Stammdaten und Einstellungen der Organisation (alle Anzeigen). */
  ORGANIZATION = 'organization',
  /** Veranstaltungen, Kategorien, Produkte, Gutscheine, Pfand, Wertmarken. */
  CATALOG = 'catalog',
  /** Kassieren: Bestellungen, Zahlungen, Erstattungen, Tische, Bedienungen,
   *  Kassenbuch, Belege, PIN-Eingabe, Kartenterminal, Kassenlade. */
  SALES = 'sales',
  /** Stationsanzeige: offene Positionen sehen und als fertig melden. */
  STATION = 'station',
  /** Drucker-Agent: eigene Drucker, Vorlagen, gefundene Drucker melden. */
  PRINTING = 'printing',
}

type DeviceLike = Pick<Device, 'type'> & {
  settings?: { displayMode?: string | null } | null;
};

/**
 * Faehigkeiten je Geraetetyp:
 *
 * | Typ                          | organization | catalog | sales | station | printing |
 * |------------------------------|:-:|:-:|:-:|:-:|:-:|
 * | `pos`, `admin` (Kasse)       | ✓ | ✓ | ✓ |   |   |
 * | `display`, Kundenanzeige     | ✓ |   |   |   |   |
 * | `display`, Stationsanzeige   | ✓ |   |   | ✓ |   |
 * | `printer_agent`              |   |   |   |   | ✓ |
 *
 * `admin` oeffnet in der Web-App die Kassenoberflaeche und darf deshalb
 * dasselbe wie eine Kasse.
 */
export function deviceCapabilities(
  device: DeviceLike,
): ReadonlySet<DeviceCapabilityName> {
  const C = DeviceCapabilityName;
  switch (device.type as string) {
    case 'pos':
    case 'admin':
      return new Set([C.ORGANIZATION, C.CATALOG, C.SALES]);
    case 'display':
      return device.settings?.displayMode === 'station'
        ? new Set([C.ORGANIZATION, C.STATION])
        : new Set([C.ORGANIZATION]);
    case 'printer_agent':
      return new Set([C.PRINTING]);
    default:
      return new Set();
  }
}

export function deviceCan(
  device: DeviceLike,
  capability: DeviceCapabilityName,
): boolean {
  return deviceCapabilities(device).has(capability);
}
