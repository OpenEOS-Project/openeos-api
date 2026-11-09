/**
 * Einstellungen der ausgehenden Webhooks (README „Webhooks“). Gehostet und
 * selbst betrieben gleich; jede Grenze per Umgebungsvariable.
 */
export interface WebhooksConfig {
  /** `WEBHOOKS_ENABLED` (Standard an): Zustellung und Anlegen. */
  enabled: boolean;
  /** Zeit je Versuch bis zur vollstaendigen Antwort (`WEBHOOKS_TIMEOUT_MS`). */
  timeoutMs: number;
  /** Versuche je Zustellung, der erste eingeschlossen (`WEBHOOKS_MAX_ATTEMPTS`). */
  maxAttempts: number;
  /** Endpunkte je Organisation (`WEBHOOKS_MAX_ENDPOINTS_PER_ORG`). */
  maxEndpointsPerOrganization: number;
  /** Abschalten nach so vielen Fehlversuchen in Folge … */
  disableAfterFailures: number;
  /** … wenn die Fehlerserie mindestens so viele Stunden dauert. */
  disableAfterHours: number;
  /** Zustellprotokoll (`WEBHOOKS_DELIVERY_RETENTION_DAYS`). */
  deliveryRetentionDays: number;
  /** Abfrage von Postausgang und faelligen Zustellungen. */
  pollIntervalMs: number;
  /** Gleichzeitige Zustellungen je Instanz. */
  concurrency: number;
  /** `http://` zulassen — nur fuer eigene Installationen im lokalen Netz. */
  allowHttp: boolean;
  /**
   * Private Netze (RFC 1918, Loopback, ULA, CGNAT) als Ziel zulassen — fuer
   * Empfaenger im eigenen Netz einer selbst betriebenen Installation.
   * Link-local und Cloud-Metadaten bleiben immer gesperrt.
   */
  allowPrivateNetworks: boolean;
}

/** Wie lange ein erneuertes Geheimnis noch mitsigniert. */
export const PREVIOUS_SECRET_GRACE_HOURS = 24;

/** Empfehlung an Empfaenger: so alt darf `t` hoechstens sein. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** Von der Antwort des Empfaengers gespeichert (Zeichen). */
export const RESPONSE_BODY_LIMIT = 1024;

/**
 * Der Postausgang wird erst nach dieser Zeit abgeholt: manche Stellen
 * legen die Bestellung und ihre Positionen in getrennten Transaktionen an —
 * so sind die Positionen im Webhook dabei.
 */
export const OUTBOX_SETTLE_MS = 2000;

export const WEBHOOKS_CONFIG = Symbol('WEBHOOKS_CONFIG');

type Env = Record<string, string | undefined>;

function int(
  env: Env,
  key: string,
  fallback: number,
  min: number,
  max: number,
) {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

export function loadWebhooksConfig(env: Env = process.env): WebhooksConfig {
  return {
    enabled: bool(env, 'WEBHOOKS_ENABLED', true),
    timeoutMs: int(env, 'WEBHOOKS_TIMEOUT_MS', 10_000, 1_000, 30_000),
    maxAttempts: int(env, 'WEBHOOKS_MAX_ATTEMPTS', 8, 1, 8),
    maxEndpointsPerOrganization: int(
      env,
      'WEBHOOKS_MAX_ENDPOINTS_PER_ORG',
      10,
      1,
      100,
    ),
    disableAfterFailures: int(
      env,
      'WEBHOOKS_DISABLE_AFTER_FAILURES',
      30,
      1,
      10_000,
    ),
    disableAfterHours: int(env, 'WEBHOOKS_DISABLE_AFTER_HOURS', 24, 0, 24 * 30),
    deliveryRetentionDays: int(
      env,
      'WEBHOOKS_DELIVERY_RETENTION_DAYS',
      30,
      1,
      365,
    ),
    pollIntervalMs: int(env, 'WEBHOOKS_POLL_INTERVAL_MS', 3_000, 500, 60_000),
    concurrency: int(env, 'WEBHOOKS_CONCURRENCY', 10, 1, 50),
    allowHttp: bool(env, 'WEBHOOKS_ALLOW_HTTP', false),
    allowPrivateNetworks: bool(env, 'WEBHOOKS_ALLOW_PRIVATE_NETWORKS', false),
  };
}
