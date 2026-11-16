/**
 * Rechtstexte von LUXCODE fuer die gehostete Instanz (openeos.de).
 *
 * Die Texte selbst liegen auf der Website (openeos-landing,
 * `content/legal/de/<dokument>/<fassung>.md`); jede Fassung bleibt dort
 * unter `/<pfad>/<fassung>` abrufbar, als PDF unter
 * `/rechtstexte/<pfad>-<fassung>.pdf`. Die API kennt nur die aktuelle
 * Fassung je Dokument — das Datum der „Stand“-Zeile.
 */

/**
 * Datum der „Stand“-Zeile der aktuell veroeffentlichten Texte. Bei einer
 * neuen Fassung hier (oder per LEGAL_*_VERSION) anheben — gleichzeitig mit
 * der neuen Datei auf der Website. Fuer AGB und AVV loest das bei allen
 * Admins die erneute Annahme aus.
 */
export const DEFAULT_LEGAL_VERSIONS = {
  agb: '2026-11-12',
  avv: '2026-11-12',
  privacy: '2026-11-12',
  imprint: '2026-11-12',
  /** Anlage 1 zu den AGB: Leistungsbeschreibung und Preisliste. */
  anlage1: '2026-11-12',
} as const;

export type LegalDocumentKey = keyof typeof DEFAULT_LEGAL_VERSIONS;

/** Pfade der Dokumente auf der Website. */
export const LEGAL_PATHS: Record<LegalDocumentKey, string> = {
  agb: 'agb',
  avv: 'avv',
  privacy: 'datenschutz',
  imprint: 'impressum',
  anlage1: 'leistungsbeschreibung',
};

export interface LegalConfig {
  /** false bei eigenstaendigem Betrieb: dort gelten die LUXCODE-Texte nicht. */
  enabled: boolean;
  /** Basis der Website ohne Schraegstrich am Ende, z. B. https://openeos.de */
  siteUrl: string;
  versions: Record<LegalDocumentKey, string>;
  /**
   * Bestehende Admins nach einer neuen Fassung von AGB/AVV erneut fragen
   * (blockierender Dialog)? Standard aus (`LEGAL_REACCEPTANCE_ENABLED`):
   * Die Fassung vom 12.11.2026 sind die ersten AGB fuer echte Kunden, es
   * gibt keine Bestandskunden zu fragen. Angenommen wird weiter bei der
   * Registrierung und bei jeder kostenpflichtigen Buchung.
   */
  reacceptanceEnabled: boolean;
}

export interface LegalDocumentLinks {
  version: string;
  /** Aktuelle Fassung. */
  url: string;
  /** Genau diese Fassung (Archiv-Adresse). */
  versionUrl: string;
  pdfUrl: string;
}

const VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Website aus der App-Adresse ableiten: app.openeos.de → openeos.de,
 * app.staging.openeos.de → staging.openeos.de. So zeigt Staging ohne
 * weitere Variable auf die Staging-Website (dort liegen neue Fassungen
 * zuerst).
 */
export function siteUrlFromAppUrl(appUrl: string | undefined): string | null {
  if (!appUrl) return null;
  try {
    const url = new URL(appUrl);
    if (!url.hostname.startsWith('app.')) return null;
    return `${url.protocol}//${url.hostname.slice(4)}`;
  } catch {
    return null;
  }
}

export function legalConfigFromEnv(
  env: Record<string, string | undefined>,
  selfHosted: boolean,
): LegalConfig {
  const version = (key: string, fallback: string) => {
    const value = env[key]?.trim();
    return value && VERSION_PATTERN.test(value) ? value : fallback;
  };
  const explicit = env.LEGAL_SITE_URL?.trim();
  const siteUrl = (
    explicit ||
    siteUrlFromAppUrl(env.APP_URL) ||
    'https://openeos.de'
  ).replace(/\/+$/, '');
  return {
    enabled: !selfHosted,
    siteUrl,
    reacceptanceEnabled:
      env.LEGAL_REACCEPTANCE_ENABLED?.trim().toLowerCase() === 'true',
    versions: {
      agb: version('LEGAL_AGB_VERSION', DEFAULT_LEGAL_VERSIONS.agb),
      avv: version('LEGAL_AVV_VERSION', DEFAULT_LEGAL_VERSIONS.avv),
      privacy: version('LEGAL_PRIVACY_VERSION', DEFAULT_LEGAL_VERSIONS.privacy),
      imprint: version('LEGAL_IMPRINT_VERSION', DEFAULT_LEGAL_VERSIONS.imprint),
      anlage1: version('LEGAL_ANLAGE1_VERSION', DEFAULT_LEGAL_VERSIONS.anlage1),
    },
  };
}

/** Links auf eine bestimmte Fassung eines Dokuments. */
export function legalLinks(
  config: Pick<LegalConfig, 'siteUrl'>,
  document: LegalDocumentKey,
  version: string,
): LegalDocumentLinks {
  const path = LEGAL_PATHS[document];
  return {
    version,
    url: `${config.siteUrl}/${path}`,
    versionUrl: `${config.siteUrl}/${path}/${version}`,
    pdfUrl: `${config.siteUrl}/rechtstexte/${path}-${version}.pdf`,
  };
}

/** Alle Dokumente in der aktuellen Fassung. */
export function currentLegalLinks(
  config: LegalConfig,
): Record<LegalDocumentKey, LegalDocumentLinks> {
  return {
    agb: legalLinks(config, 'agb', config.versions.agb),
    avv: legalLinks(config, 'avv', config.versions.avv),
    privacy: legalLinks(config, 'privacy', config.versions.privacy),
    imprint: legalLinks(config, 'imprint', config.versions.imprint),
    anlage1: legalLinks(config, 'anlage1', config.versions.anlage1),
  };
}
