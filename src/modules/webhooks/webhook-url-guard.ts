import { promises as dns } from 'dns';
import { BlockList, isIP } from 'net';

/**
 * Schutz vor SSRF: Ein Webhook-Ziel gibt der Verein selbst vor. Ohne
 * Pruefung koennte er damit Dienste im Netz des Servers ansprechen
 * (Datenbank, Redis, Cloud-Metadaten unter 169.254.169.254).
 *
 * - Beim Anlegen: nur `https://`, keine Zugangsdaten in der Adresse, der
 *   Name muss sich aufloesen lassen und nur auf oeffentliche Adressen zeigen.
 * - Bei jedem Versand noch einmal (DNS kann sich aendern, „DNS-Rebinding“):
 *   der Sender verbindet sich dann mit genau der gepruefen Adresse
 *   (`lookup` gepinnt, siehe webhook-http.ts) und folgt keiner Weiterleitung.
 */

export type AddressClass = 'public' | 'private' | 'forbidden';

function blockList(entries: Array<[string, number, 'ipv4' | 'ipv6']>) {
  const list = new BlockList();
  for (const [net, prefix, type] of entries) list.addSubnet(net, prefix, type);
  return list;
}

/** Eigene Netze — mit `WEBHOOKS_ALLOW_PRIVATE_NETWORKS` erlaubt. */
const PRIVATE = blockList([
  ['10.0.0.0', 8, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['::1', 128, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
]);

/** Nie erlaubt: link-local, Metadaten, Dokumentation, Multicast, reserviert. */
const FORBIDDEN = blockList([
  ['0.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['100.100.100.200', 32, 'ipv4'], // Metadaten (Alibaba), liegt in 100.64/10
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['192.88.99.0', 24, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['fec0::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
  ['fd00:ec2::254', 128, 'ipv6'], // Metadaten (AWS), liegt in fc00::/7
  ['100::', 64, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
  ['2001::', 32, 'ipv6'], // Teredo
  ['2002::', 16, 'ipv6'], // 6to4 (bettet IPv4 ein)
  ['64:ff9b::', 96, 'ipv6'], // NAT64 (bettet IPv4 ein)
  ['64:ff9b:1::', 48, 'ipv6'],
]);

/** Oeffentliche IPv6-Unicast-Adressen liegen alle in 2000::/3. */
const IPV6_GLOBAL = blockList([['2000::', 3, 'ipv6']]);

/** `::ffff:1.2.3.4` bzw. `::ffff:102:304` → `1.2.3.4`. */
function mappedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(
    lower,
  );
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }
  return null;
}

export function classifyAddress(address: string): AddressClass {
  const family = isIP(address);
  if (family === 4) {
    if (FORBIDDEN.check(address, 'ipv4')) return 'forbidden';
    if (PRIVATE.check(address, 'ipv4')) return 'private';
    return 'public';
  }
  if (family === 6) {
    const v4 = mappedIpv4(address);
    if (v4) return classifyAddress(v4);
    if (FORBIDDEN.check(address, 'ipv6')) return 'forbidden';
    if (PRIVATE.check(address, 'ipv6')) return 'private';
    if (!IPV6_GLOBAL.check(address, 'ipv6')) return 'forbidden';
    return 'public';
  }
  return 'forbidden';
}

export function isAddressAllowed(
  address: string,
  options: { allowPrivateNetworks: boolean },
): boolean {
  const cls = classifyAddress(address);
  return (
    cls === 'public' || (cls === 'private' && options.allowPrivateNetworks)
  );
}

export type WebhookUrlProblem =
  | 'invalid'
  | 'not_https'
  | 'credentials'
  | 'private_address'
  | 'unresolvable';

export interface UrlGuardOptions {
  allowHttp: boolean;
  allowPrivateNetworks: boolean;
}

export class WebhookTargetError extends Error {
  constructor(
    readonly code: 'DNS_FAILED' | 'BLOCKED_ADDRESS',
    message: string,
  ) {
    super(message);
  }
}

/** Form der Adresse (ohne DNS). `null` = in Ordnung. */
export function checkWebhookUrlSyntax(
  raw: string,
  options: Pick<UrlGuardOptions, 'allowHttp'>,
): { url: URL } | { problem: WebhookUrlProblem } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { problem: 'invalid' };
  }
  if (
    url.protocol !== 'https:' &&
    !(options.allowHttp && url.protocol === 'http:')
  ) {
    return { problem: url.protocol === 'http:' ? 'not_https' : 'invalid' };
  }
  if (url.username || url.password) return { problem: 'credentials' };
  if (!url.hostname) return { problem: 'invalid' };
  return { url };
}

/** Rechnername ohne die Klammern einer IPv6-Adresse. */
export function bareHostname(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, '$1');
}

export interface ResolvedTarget {
  address: string;
  family: 4 | 6;
}

export type LookupAll = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

const systemLookup: LookupAll = (hostname) =>
  dns.lookup(hostname, { all: true, verbatim: true });

/**
 * Loest den Namen auf und prueft **alle** Adressen; eine einzige gesperrte
 * genuegt zur Ablehnung (sonst liesse sich mit einem zweiten A-Eintrag
 * eine interne Adresse unterschieben). Liefert die erste erlaubte.
 */
export async function resolveWebhookTarget(
  hostname: string,
  options: Pick<UrlGuardOptions, 'allowPrivateNetworks'>,
  lookup: LookupAll = systemLookup,
): Promise<ResolvedTarget> {
  const literal = isIP(hostname);
  let addresses: Array<{ address: string; family: number }>;
  if (literal) {
    addresses = [{ address: hostname, family: literal }];
  } else {
    try {
      addresses = await lookup(hostname);
    } catch (error) {
      throw new WebhookTargetError(
        'DNS_FAILED',
        `DNS lookup failed: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`,
      );
    }
    if (addresses.length === 0) {
      throw new WebhookTargetError('DNS_FAILED', 'DNS lookup returned nothing');
    }
  }
  for (const entry of addresses) {
    if (!isAddressAllowed(entry.address, options)) {
      throw new WebhookTargetError(
        'BLOCKED_ADDRESS',
        `Target resolves to a non-public address`,
      );
    }
  }
  const first = addresses[0];
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

/** Pruefung beim Anlegen und Aendern: Form, dann DNS. */
export async function validateWebhookUrl(
  raw: string,
  options: UrlGuardOptions,
  lookup?: LookupAll,
): Promise<
  { ok: true; url: string } | { ok: false; problem: WebhookUrlProblem }
> {
  const syntax = checkWebhookUrlSyntax(raw, options);
  if ('problem' in syntax) return { ok: false, problem: syntax.problem };
  try {
    await resolveWebhookTarget(bareHostname(syntax.url), options, lookup);
  } catch (error) {
    if (error instanceof WebhookTargetError) {
      return {
        ok: false,
        problem:
          error.code === 'BLOCKED_ADDRESS' ? 'private_address' : 'unresolvable',
      };
    }
    throw error;
  }
  syntax.url.hash = '';
  return { ok: true, url: syntax.url.toString() };
}
