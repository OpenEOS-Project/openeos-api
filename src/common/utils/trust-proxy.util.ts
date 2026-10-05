import { isIP } from 'net';

/**
 * Express `trust proxy` setting, read from the TRUST_PROXY env variable.
 *
 * The API runs behind a reverse proxy (Traefik in the Docker setup). Without
 * this setting `req.ip` is the proxy's address, so sessions, the audit log
 * and the rate limiter all see the same internal IP for every client.
 *
 * Accepted values:
 *   - unset / empty: DEFAULT_TRUST_PROXY — trust proxies on loopback,
 *     link-local and private networks (Docker bridge, LAN). A client
 *     connecting from a public address can not inject X-Forwarded-For.
 *   - a non-negative integer: number of proxy hops in front of the API
 *     (`1` = exactly one reverse proxy, which must append the client IP).
 *   - a comma-separated list of IPs, CIDR ranges or the presets
 *     `loopback`, `linklocal`, `uniquelocal`.
 *   - `false` / `off` / `0`: trust no proxy, use the socket address.
 *
 * `true` (trust every hop) is refused on purpose: it takes the left-most
 * X-Forwarded-For entry, which any client can set to an arbitrary value.
 */
export const DEFAULT_TRUST_PROXY = 'loopback, linklocal, uniquelocal';

export type TrustProxySetting = false | number | string;

export interface ParsedTrustProxy {
  value: TrustProxySetting;
  /** Set when the configured value was rejected and the default is used. */
  warning?: string;
}

const PRESETS = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** IPv4/IPv6 address, optionally with a CIDR prefix length or a netmask. */
function isAddressOrRange(entry: string): boolean {
  const [address, range, ...rest] = entry.split('/');
  if (rest.length > 0 || isIP(address) === 0) return false;
  if (range === undefined) return true;
  return /^\d{1,3}$/.test(range) || isIP(range) !== 0;
}

export function parseTrustProxy(
  raw: string | undefined | null,
): ParsedTrustProxy {
  const input = (raw ?? '').trim();
  if (input === '') return { value: DEFAULT_TRUST_PROXY };

  const lower = input.toLowerCase();
  if (lower === 'false' || lower === 'off' || lower === 'none') {
    return { value: false };
  }

  if (/^\d+$/.test(input)) {
    const hops = Number(input);
    return { value: hops === 0 ? false : hops };
  }

  if (lower === 'true') {
    return {
      value: DEFAULT_TRUST_PROXY,
      warning:
        'TRUST_PROXY=true would trust client-supplied X-Forwarded-For headers; ' +
        `using "${DEFAULT_TRUST_PROXY}" instead. Set a hop count or the proxy addresses.`,
    };
  }

  const entries = input
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const invalid = entries.filter(
    (entry) => !PRESETS.has(entry.toLowerCase()) && !isAddressOrRange(entry),
  );
  if (entries.length === 0 || invalid.length > 0) {
    return {
      value: DEFAULT_TRUST_PROXY,
      warning: `TRUST_PROXY contains invalid entries (${invalid.join(', ')}); using "${DEFAULT_TRUST_PROXY}" instead.`,
    };
  }

  return {
    value: entries
      .map((entry) =>
        PRESETS.has(entry.toLowerCase()) ? entry.toLowerCase() : entry,
      )
      .join(', '),
  };
}
